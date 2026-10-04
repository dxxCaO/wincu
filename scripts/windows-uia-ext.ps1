# ============================================================================
# windows-uia-ext.ps1 - wincu extension layer (loaded by windows-uia.ps1)
#   M1: capabilities / clipboard / app lifecycle / result envelope (identity+timing)
#   M2: verify_state / observation budget (region, returnMode, diffOnly)
#   M3: agent cursor overlay / delivery ladder / red lines
#   M4: recording + replay
#   M5: vision fallback (OCR preprocessing / describe)
# ASCII-only on purpose: Windows PowerShell 5.1 parses BOM-less files with the
# system code page, so non-ASCII bytes here would corrupt parsing.
# ============================================================================

$script:WcuExtNativeReady = $false
$script:WcuAgentCursor = $null
$script:WcuLastFrame = @{}
$script:WcuRecord = $null
$script:WcuLocks = @{}
$script:WcuDragSession = $null
$script:WcuAppIndexCache = $null
$script:WcuObservations = @{}
$script:WcuBaselines = $null
$script:WcuObsSeq = 0
$script:WcuDragSession = $null
$script:WcuObservations = @{}
$script:WcuBaselines = $null
$script:WcuObsSeq = 0

function Initialize-WcuExtNative {
  if ($script:WcuExtNativeReady) { return }
  Add-Type -Namespace WcuExt -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
[DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
[DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
[DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
[DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int cls, out uint info, uint len, out uint ret);
'@
  $script:WcuExtNativeReady = $true
}

# ---------------------------------------------------------------- helpers
# Tolerant int conversion: [int] casts can hit arrays when a value flows through
# a pipeline or a collection, which used to break launch_app.
function ConvertTo-WcuInt {
  param($Value)
  if ($null -eq $Value) { return -1 }
  if ($Value -is [array]) {
    if ($Value.Count -gt 0) { return (ConvertTo-WcuInt $Value[0]) }
    return -1
  }
  $n = 0
  if ([int]::TryParse([string]$Value, [ref]$n)) { return $n }
  return -1
}

function Get-WcuProcessName {
  param([int]$ProcessId)
  try { return (Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName } catch { return "" }
}

function Test-WcuElevated {
  param([int]$ProcessId = $PID)
  Initialize-WcuExtNative
  $h = [WcuExt.Native]::OpenProcess(0x1000, $false, $ProcessId)
  if ($h -eq [IntPtr]::Zero) { return $null }
  try {
    $tok = [IntPtr]::Zero
    if (-not [WcuExt.Native]::OpenProcessToken($h, 0x0008, [ref]$tok)) { return $null }
    try {
      $info = [uint32]0
      $ret = [uint32]0
      if ([WcuExt.Native]::GetTokenInformation($tok, 20, [ref]$info, 4, [ref]$ret)) { return ($info -ne 0) }
      return $null
    } finally { [void][WcuExt.Native]::CloseHandle($tok) }
  } finally { [void][WcuExt.Native]::CloseHandle($h) }
}

function Get-WcuHwndInfo {
  param([int]$Handle)
  Initialize-WcuExtNative
  $hwnd = [IntPtr]$Handle
  $sbT = New-Object System.Text.StringBuilder 512
  [void][WcuExt.Native]::GetWindowTextW($hwnd, $sbT, 512)
  $sbC = New-Object System.Text.StringBuilder 256
  [void][WcuExt.Native]::GetClassNameW($hwnd, $sbC, 256)
  $procId = 0
  [void][WcuExt.Native]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  return [ordered]@{
    hwnd = $Handle
    title = $sbT.ToString()
    className = $sbC.ToString()
    processId = $procId
    processName = (Get-WcuProcessName -ProcessId $procId)
    visible = [WcuExt.Native]::IsWindowVisible($hwnd)
  }
}

function Get-WcuForegroundIdentity {
  Initialize-WcuExtNative
  $hwnd = [WcuExt.Native]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  $base = Get-WcuHwndInfo -Handle ([int]$hwnd)
  $base["elevated"] = (Test-WcuElevated -ProcessId ([int]$base.processId))
  $base["resolvedBy"] = "foreground"
  return $base
}

# Structured target identity: explicit target first, foreground window as fallback.
function Get-WcuTargetIdentity {
  param($InputObject = $null, $Element = $null)
  $el = $Element
  $resolvedBy = "explicit"
  if ($null -eq $el -and $null -ne $InputObject) { $el = Invoke-Safe { Resolve-TargetWindow $InputObject } $null }
  if ($null -eq $el) {
    $el = Invoke-Safe { Get-ScopeRoot "active_window" } $null
    $resolvedBy = "foreground"
  }
  if ($null -eq $el) { return (Get-WcuForegroundIdentity) }
  $info = Invoke-Safe { Convert-ElementInfo -Element $el -Id $null -Depth 0 } $null
  if ($null -eq $info) { return (Get-WcuForegroundIdentity) }
  $procId = ConvertTo-WcuInt $info.processId
  $hwnd = ConvertTo-WcuInt $info.nativeWindowHandle
  $out = [ordered]@{
    hwnd = $hwnd
    processId = $procId
    processName = (Get-WcuProcessName -ProcessId $procId)
    title = $info.name
    className = $info.className
    controlType = $info.controlType
    boundingBox = $info.boundingBox
    elevated = (Test-WcuElevated -ProcessId $procId)
    resolvedBy = $resolvedBy
  }
  try {
    $scr = [System.Windows.Forms.Screen]::FromHandle([IntPtr]$hwnd)
    if ($null -ne $scr) {
      $out["monitor"] = [ordered]@{
        deviceName = $scr.DeviceName
        primary = $scr.Primary
        bounds = [ordered]@{ x = $scr.Bounds.X; y = $scr.Bounds.Y; width = $scr.Bounds.Width; height = $scr.Bounds.Height }
      }
    }
  } catch { }
  return $out
}

# ---------------------------------------------------------------- envelope
function Add-ResultEnvelope {
  param($Result, [string]$Action, $InputObject = $null, [int]$ElapsedMs = -1)
  if ($null -eq $Result) { return $Result }
  if (-not ($Result -is [System.Collections.IDictionary])) { return $Result }
  $envelope = [ordered]@{ schema = "wcu-envelope/1"; action = $Action; elapsedMs = $ElapsedMs }
  $hasTarget = $false
  if ($null -ne $InputObject) {
    if ($null -ne (Get-Prop $InputObject "windowTitle" $null)) { $hasTarget = $true }
    if ($null -ne (Get-Prop $InputObject "processId" $null)) { $hasTarget = $true }
    if ($null -ne (Get-Prop $InputObject "nativeWindowHandle" $null)) { $hasTarget = $true }
  }
  $identity = $null
  if ($hasTarget) { $identity = Invoke-Safe { Get-WcuTargetIdentity -InputObject $InputObject } $null }
  if ($null -eq $identity) { $identity = Invoke-Safe { Get-WcuForegroundIdentity } $null }
  if ($null -ne $identity) { $envelope["target"] = $identity }
  if (-not $Result.Contains("ok")) { $Result["ok"] = $true }
  $Result["envelope"] = $envelope
  return $Result
}

# ---------------------------------------------------------------- clipboard
function Get-WcuClipboard {
  param([bool]$IncludeText = $false, [bool]$IncludeImage = $false)
  $info = [ordered]@{ action = "clipboard_read" }
  try {
    $info["hasText"] = [System.Windows.Forms.Clipboard]::ContainsText()
    $info["hasImage"] = [System.Windows.Forms.Clipboard]::ContainsImage()
    $info["hasFileDropList"] = [System.Windows.Forms.Clipboard]::ContainsFileDropList()
    if ($info["hasText"]) {
      $text = [System.Windows.Forms.Clipboard]::GetText()
      $info["textLength"] = $text.Length
      if ($IncludeText) { $info["text"] = $text }
      if ($text.Length -gt 200) { $info["textPreview"] = $text.Substring(0, 200) } else { $info["textPreview"] = $text }
    }
    if ($info["hasFileDropList"]) { $info["fileDropList"] = @([System.Windows.Forms.Clipboard]::GetFileDropList()) }
    if ($IncludeImage -and $info["hasImage"]) {
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      $info["image"] = [ordered]@{ width = $img.Width; height = $img.Height }
      $img.Dispose()
    }
  } catch {
    $info["clipboardError"] = $_.Exception.Message
    try {
      $text = Get-Clipboard -Raw -ErrorAction Stop
      $info["hasText"] = $true
      $info["textLength"] = ([string]$text).Length
      if ($IncludeText) { $info["text"] = $text }
      $info["fallback"] = "Get-Clipboard"
    } catch { $info["fallbackError"] = $_.Exception.Message }
  }
  $info["ok"] = $true
  return $info
}

function Set-WcuClipboardText {
  param([string]$Text)
  try {
    [System.Windows.Forms.Clipboard]::SetText($Text)
    return [ordered]@{ ok = $true; action = "clipboard_write"; length = $Text.Length; backend = "WinForms" }
  } catch {
    Set-Clipboard -Value $Text -ErrorAction Stop
    return [ordered]@{ ok = $true; action = "clipboard_write"; length = $Text.Length; backend = "Set-Clipboard" }
  }
}

# ---------------------------------------------------------------- app lifecycle
function Get-WcuWindowSnapshotSet {
  $set = @{}
  foreach ($w in (Get-NativeWindowList -IncludeInvisible $true -MaxWindows 500)) {
    $set[[string](ConvertTo-WcuInt $w.nativeWindowHandle)] = $true
  }
  return $set
}

function Start-WcuApp {
  param($InputObject)
  $path = Get-Prop $InputObject "path" $null
  $aumid = Get-Prop $InputObject "aumid" $null
  $url = Get-Prop $InputObject "url" $null
  $argList = Get-Prop $InputObject "arguments" $null
  $workDir = Get-Prop $InputObject "workingDirectory" $null
  $waitMs = [int](Get-Prop $InputObject "waitMs" 8000)
  # Defensive routing: the app index returns AUMIDs and URIs, and callers hand
  # them over in `path`. Classify by shape instead of failing with a .NET error.
  if ($null -eq $aumid -and $null -eq $url -and $null -ne $path) {
    $p = [string]$path
    if ($p.StartsWith("shell:AppsFolder\")) { $aumid = $p.Replace("shell:AppsFolder\", ""); $path = $null }
    elseif ($p -match '^[A-Za-z][A-Za-z0-9+.\-]*:' -and $p -notmatch '^[A-Za-z]:[\\/]') { $url = $p; $path = $null }
    elseif ($p -match '!' -and $p -notmatch '[\\/]') { $aumid = $p; $path = $null }
  }
  if ($null -eq $path -and $null -eq $aumid -and $null -eq $url) {
    throw "launch_app needs one of: path (exe), aumid (packaged app), url (default browser)."
  }
  $launchVia = "path"
  if ($null -ne $aumid) { $launchVia = "aumid" } elseif ($null -ne $url) { $launchVia = "url" }
  $before = Get-WcuWindowSnapshotSet
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $proc = $null
  $shellHandoff = ''
  if ($null -ne $aumid) {
    # Packaged apps can only be started through the shell namespace, and the
    # channel varies by environment: explorer.exe hands off to the running shell
    # (denied on hardened boxes), while `cmd /c start` and ShellExecute work.
    # Try them in that order and only then fall back to the raw shell path.
    $proc = $null
    $handoffTarget = 'shell:AppsFolder\' + $aumid
    try {
      $helper = Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c start "" "' + $handoffTarget + '"') -PassThru -WindowStyle Hidden
      if ($null -ne $helper) { [void]$helper.WaitForExit(8000) }
      $shellHandoff = 'cmd-start'
    } catch { $shellHandoff = '' }
    if ([string]::IsNullOrEmpty($shellHandoff)) {
      try { $proc = Start-Process -FilePath "explorer.exe" -ArgumentList $handoffTarget -PassThru; $shellHandoff = 'explorer' } catch { $proc = $null }
    }
    if ($null -eq $proc -and [string]::IsNullOrEmpty($shellHandoff)) { $proc = Start-Process -FilePath $handoffTarget -PassThru }
  } elseif ($null -ne $url) {
    # Same story for protocol URIs (ms-settings:, https:, ...).
    $proc = $null
    try {
      $helper = Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c start "" "' + $url + '"') -PassThru -WindowStyle Hidden
      if ($null -ne $helper) { [void]$helper.WaitForExit(8000) }
      $shellHandoff = 'cmd-start'
    } catch { $shellHandoff = '' }
    if ([string]::IsNullOrEmpty($shellHandoff)) { $proc = Start-Process -FilePath $url -PassThru }
  } else {
    $sp = @{ FilePath = $path; PassThru = $true }
    if ($null -ne $argList) {
      if ($argList -is [array]) { $sp["ArgumentList"] = @($argList) } else { $sp["ArgumentList"] = @([string]$argList) }
    }
    if ($null -ne $workDir) { $sp["WorkingDirectory"] = [string]$workDir }
    $proc = Start-Process @sp
  }
  $launchedPid = -1
  $reusedExisting = $false
  if ($null -ne $proc) { $launchedPid = ConvertTo-WcuInt (@($proc)[0].Id) }
  $launcherPid = $launchedPid
  $newWindows = @()
  $deadline = [DateTime]::UtcNow.AddMilliseconds($waitMs)
  do {
    Start-Sleep -Milliseconds 250
    $found = New-Object System.Collections.Generic.List[object]
    foreach ($w in (Get-NativeWindowList -IncludeInvisible $false -MaxWindows 500)) {
      $wpid = ConvertTo-WcuInt $w.processId
      $whnd = [string](ConvertTo-WcuInt $w.nativeWindowHandle)
      if (($launchedPid -ge 0 -and $wpid -eq $launchedPid) -or (-not $before.ContainsKey($whnd))) {
        [void]$found.Add($w)
      }
    }
    $newWindows = @($found.ToArray())
  } while ($newWindows.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline)
  # explorer.exe shell:AppsFolder\... hands back the LAUNCHER pid, which is
  # useless for follow-up calls; prefer the pid that owns the new window.
  if ($newWindows.Count -eq 0) {
    # The app was ALREADY RUNNING, so the shell only focused the existing
    # instance and no new window appeared. Reporting the launcher pid here made
    # follow-up calls resolve to nothing (and silently fall back to whatever was
    # in the foreground), so report the window the shell just focused instead.
    $fgHwnd = ConvertTo-WcuInt ([WcuExt.Native]::GetForegroundWindow())
    if ($fgHwnd -gt 0) {
      $fgPid = ConvertTo-WcuInt (Invoke-Safe { [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$fgHwnd).Current.ProcessId } 0)
      if ($fgPid -gt 0) {
        $launchedPid = $fgPid
        $reusedExisting = $true
      }
    }
  }
  if ($newWindows.Count -gt 0) {
    $windowPid = ConvertTo-WcuInt (@($newWindows)[0].processId)
    if ($windowPid -gt 0 -and $windowPid -ne $launchedPid) { $launchedPid = $windowPid }
  }
  $result = [ordered]@{
    ok = $true
    action = "launch_app"
    launchVia = $launchVia
    shellHandoff = $(if ($shellHandoff) { $shellHandoff } else { 'direct' })
    reusedExistingWindow = $reusedExisting
    launcherPid = $(if ($launcherPid -ge 0) { $launcherPid } else { $null })
    pid = $(if ($launchedPid -ge 0) { $launchedPid } else { $null })
    processName = $(if ($launchedPid -ge 0) { (Get-WcuProcessName -ProcessId $launchedPid) } else { "" })
    waitedMs = [int]$sw.ElapsedMilliseconds
    windowCount = $newWindows.Count
    windows = $newWindows
  }
  if ($newWindows.Count -eq 0) {
    if ($reusedExisting) { $result["note"] = "The app was already running, so the shell focused its existing window; pid/processName describe that window." }
    $result["warning"] = "Process started but no new visible top-level window appeared within " + $waitMs + "ms (still loading, or the app reuses an existing window)."
  }
  return $result
}

function Stop-WcuApp {
  param($InputObject)
  $mode = [string](Get-Prop $InputObject "mode" "close")
  $timeoutMs = [int](Get-Prop $InputObject "timeoutMs" 4000)
  $procId = ConvertTo-WcuInt (Get-Prop $InputObject "processId" 0)
  $procName = Get-Prop $InputObject "processName" $null
  $hwnd = Get-Prop $InputObject "nativeWindowHandle" $null
  $targets = @()
  if ($procId -gt 0) { $targets = @(Get-Process -Id $procId -ErrorAction SilentlyContinue) }
  elseif ($null -ne $procName) { $targets = @(Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension([string]$procName)) -ErrorAction SilentlyContinue) }
  elseif ($null -ne $hwnd) {
    Initialize-WcuExtNative
    $owner = 0
    [void][WcuExt.Native]::GetWindowThreadProcessId([IntPtr](ConvertTo-WcuInt $hwnd), [ref]$owner)
    if ($owner -gt 0) { $targets = @(Get-Process -Id $owner -ErrorAction SilentlyContinue) }
  } else {
    throw "kill_app needs processId, processName or nativeWindowHandle."
  }
  if ($targets.Count -eq 0) { return [ordered]@{ ok = $false; action = "kill_app"; error = "No matching process found." } }
  $done = @()
  foreach ($p in $targets) {
    $entry = [ordered]@{ pid = $p.Id; processName = $p.ProcessName }
    try {
      if ($mode -eq "kill") {
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
        $entry["result"] = "killed"
      } else {
        $signalled = $p.CloseMainWindow()
        if (-not $signalled) {
          $entry["result"] = "no-window"
          $entry["hint"] = "Process has no main window to close; retry with mode:'kill'."
        } else {
          $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
          while (-not $p.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200; $p.Refresh() }
          if ($p.HasExited) { $entry["result"] = "closed" } else {
            $entry["result"] = "closing"
            $entry["hint"] = "App ignored WM_CLOSE (unsaved changes?); retry with mode:'kill' to force."
          }
        }
      }
    } catch { $entry["result"] = "error"; $entry["error"] = $_.Exception.Message }
    $done += $entry
  }
  return [ordered]@{ ok = $true; action = "kill_app"; mode = $mode; processes = $done }
}

# ---------------------------------------------------------------- capabilities
function Get-WcuBrowserProbe {
  $ports = @()
  foreach ($p in @(9222, 9223, 9224, 9333)) {
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $iar = $client.BeginConnect("127.0.0.1", $p, $null, $null)
      $ok = $iar.AsyncWaitHandle.WaitOne(120, $false)
      if ($ok -and $client.Connected) { $ports += $p }
      $client.Close()
    } catch { }
  }
  $procs = @()
  foreach ($n in @("chrome", "msedge", "firefox", "brave", "opera", "vivaldi")) {
    try { if (Get-Process -Name $n -ErrorAction SilentlyContinue) { $procs += $n } } catch { }
  }
  $hint = "wincu does not automate browsers by design. "
  if ($ports.Count -gt 0) {
    $hint += "A CDP endpoint is listening on port(s) " + ($ports -join ", ") + ": a dedicated browser plugin can drive those over the DevTools protocol."
  } elseif ($procs.Count -gt 0) {
    $hint += "Browsers are running (" + ($procs -join ", ") + ") but no DevTools port is open; start one with --remote-debugging-port=9222, or use a dedicated browser plugin."
  } else {
    $hint += "No browser detected."
  }
  return [ordered]@{ available = ($ports.Count -gt 0); cdpPorts = $ports; browsersRunning = $procs; note = $hint }
}

function Get-WcuCapabilities {
  param($InputObject)
  $probe = [string](Get-Prop $InputObject "probe" "safe")
  $degraded = New-Object System.Collections.Generic.List[string]
  $caps = [ordered]@{ action = "capabilities"; ok = $true }

  $caps["host"] = [ordered]@{
    powershell = $PSVersionTable.PSVersion.ToString()
    edition = $PSVersionTable.PSEdition
    osVersion = [System.Environment]::OSVersion.VersionString
    arch = $env:PROCESSOR_ARCHITECTURE
    pid = $PID
    mode = $(if ($Persistent) { "persistent" } else { "oneshot" })
    elevated = (Test-WcuElevated -ProcessId $PID)
  }

  $uiaOk = $false
  try { $null = [System.Windows.Automation.AutomationElement]::RootElement; $uiaOk = $true } catch { }
  $caps["uiAutomation"] = [ordered]@{ available = $uiaOk; viewModes = @("control", "content", "raw"); staleElementIds = "uia:rt:* element ids report 'stale' instead of mis-clicking" }
  if (-not $uiaOk) { $degraded.Add("uiAutomation: UIA root unreachable - tree/find/invoke/set_value will fail; fall back to screenshot + coordinate clicks.") }

  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $monitors = @()
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $monitors += [ordered]@{
      deviceName = $s.DeviceName
      primary = $s.Primary
      bounds = [ordered]@{ x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height }
      workingArea = [ordered]@{ x = $s.WorkingArea.X; y = $s.WorkingArea.Y; width = $s.WorkingArea.Width; height = $s.WorkingArea.Height }
    }
  }
  $caps["displays"] = [ordered]@{
    virtualScreen = [ordered]@{ x = $screen.Left; y = $screen.Top; width = $screen.Width; height = $screen.Height }
    monitors = $monitors
    dpiAware = $true
    note = "Coordinates are physical pixels (Per-Monitor V2 DPI awareness)."
  }

  $caps["screenshot"] = [ordered]@{
    printWindow = $true
    wgc = "lazy"
    screen = $true
    note = "Tier chain: PrintWindow -> Windows.Graphics.Capture -> screen region fallback (marked occludedPossible)."
  }

  $cursorState = "available (disabled)"
  if ($null -ne $script:WcuAgentCursor -and $script:WcuAgentCursor.enabled) { $cursorState = "enabled (virtual pointer active; the real mouse is not moved)" }
  $caps["input"] = [ordered]@{
    sendInput = $true
    postMessage = $true
    clipboard = "available"
    failsafe = ([string]$env:WCU_FAILSAFE -ne "0")
    agentCursor = $cursorState
  }

  $caps["ocr"] = [ordered]@{
    backend = "Windows.Media.Ocr"
    state = "lazy (first call compiles the C# helper)"
    preprocessing = @("upscale2x", "contrast", "invert")
    note = "Dark-theme UIs often return empty text without preprocessing; ocr.preprocess defaults to auto."
  }

  $caps["observation"] = [ordered]@{
    region = $true
    returnMode = @("inline", "file", "hash")
    diffOnly = $true
    cropToElement = $true
  }

  $caps["verify"] = [ordered]@{ verify_state = @("window_exists", "title_contains", "class_equals", "process_running", "element_present", "element_absent", "element_value", "pixel_changed", "image_changed") }

  $recordPath = $null
  if ($null -ne $script:WcuRecord) { $recordPath = $script:WcuRecord.path }
  $caps["recording"] = [ordered]@{ active = ($null -ne $script:WcuRecord); path = $recordPath; format = "jsonl (wcu-trace/1)" }

  $caps["browser"] = Get-WcuBrowserProbe

  $caps["safety"] = [ordered]@{
    redLines = @("terminal-consoles", "run-dialog", "uac-consent", "credential-ui", "antivirus-ui")
    approvalRules = "enforced in the MCP layer: kill_app{mode:'kill'}, close_window and system key chords (Alt+F4 / Ctrl+Shift+Esc) require approve:true; red lines are refused outright"
    redlineConfigFile = (Join-Path $env:USERPROFILE ".dsh\wincu-redlines.json")
  }

  if ($degraded.Count -gt 0) { $caps["degraded"] = @($degraded.ToArray()) }
  if ($probe -eq "full") { $caps["note"] = "probe:'full' requested; heavy sub-checks are still lazy by design." }
  return $caps
}


# ============================================================================
# M2: image helpers / observation budget / verification
# ============================================================================

function Get-WcuShotBitmap {
  param($Shot)
  $b64 = $Shot["base64"]
  if ([string]::IsNullOrEmpty($b64)) { return $null }
  $bytes = [Convert]::FromBase64String($b64)
  $ms = New-Object System.IO.MemoryStream(, $bytes)
  return [System.Drawing.Image]::FromStream($ms)
}

function Get-WcuPngBytes {
  param($Bitmap)
  $ms = New-Object System.IO.MemoryStream
  $Bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  return $ms.ToArray()
}

function Get-WcuHashHex {
  param([byte[]]$Bytes)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return (([BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '')).ToLowerInvariant() } finally { $sha.Dispose() }
}

# Hash the raw pixels instead of a PNG encoding: same change detection, ~40 ms
# cheaper per capture, and it does not depend on the encoder's settings.
function Get-WcuPixelsSha256 {
  param($Bitmap)
  $rect = New-Object System.Drawing.Rectangle 0, 0, $Bitmap.Width, $Bitmap.Height
  $data = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $len = [Math]::Abs($data.Stride) * $data.Height
    $buf = New-Object byte[] $len
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $len)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return (([BitConverter]::ToString($sha.ComputeHash($buf))) -replace "-", "").ToLowerInvariant() } finally { $sha.Dispose() }
  } finally { $Bitmap.UnlockBits($data) }
}

function Get-WcuBitmapHash {
  param($Bitmap)
  return (Get-WcuPixelsSha256 -Bitmap $Bitmap)
}

# Screen coordinates -> pixels inside the returned screenshot.
# Region fields arrive either as a PSCustomObject (from MCP JSON) or as an
# [ordered] dictionary built in-process (the clientArea rectangle). Get-Prop only
# handles the former, which silently turned clientArea into a 0x0 crop.
function Get-WcuRegionValue {
  param($Region, [string]$Name, [int]$Default = 0)
  if ($null -eq $Region) { return $Default }
  try {
    if ($Region -is [System.Collections.IDictionary] -and $Region.Contains($Name)) {
      return (ConvertTo-WcuInt $Region[$Name])
    }
  } catch { }
  $v = Get-Prop $Region $Name $null
  if ($null -eq $v) { return $Default }
  return (ConvertTo-WcuInt $v)
}
function Convert-WcuRegionToImage {
  param($Region, $Shot)
  $scale = 1.0
  if ($null -ne $Shot["imageScale"]) { $scale = [double]$Shot["imageScale"] }
  $ox = [int]$Shot.bounds.x
  $oy = [int]$Shot.bounds.y
  if ($null -ne $Shot["origin"]) { $ox = [int]$Shot.origin.x; $oy = [int]$Shot.origin.y }
  $x = Get-WcuRegionValue -Region $Region -Name "x"
  $y = Get-WcuRegionValue -Region $Region -Name "y"
  $w = Get-WcuRegionValue -Region $Region -Name "width"
  $h = Get-WcuRegionValue -Region $Region -Name "height"
  return [ordered]@{
    x = [int][Math]::Round(($x - $ox) * $scale)
    y = [int][Math]::Round(($y - $oy) * $scale)
    width = [int][Math]::Round($w * $scale)
    height = [int][Math]::Round($h * $scale)
  }
}

function Copy-WcuBitmapCrop {
  param($Bitmap, $Rect)
  $x = [Math]::Max(0, (ConvertTo-WcuInt $Rect.x))
  $y = [Math]::Max(0, (ConvertTo-WcuInt $Rect.y))
  $w = ConvertTo-WcuInt $Rect.width
  $h = ConvertTo-WcuInt $Rect.height
  if ($w -lt 1 -or $h -lt 1) { return $null }
  if ($x -ge $Bitmap.Width -or $y -ge $Bitmap.Height) { return $null }
  if ($x + $w -gt $Bitmap.Width) { $w = $Bitmap.Width - $x }
  if ($y + $h -gt $Bitmap.Height) { $h = $Bitmap.Height - $y }
  if ($w -lt 1 -or $h -lt 1) { return $null }
  $dst = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($dst)
  try {
    $g.DrawImage($Bitmap, [System.Drawing.Rectangle]::new(0, 0, $w, $h), [System.Drawing.Rectangle]::new($x, $y, $w, $h), [System.Drawing.GraphicsUnit]::Pixel)
  } finally { $g.Dispose() }
  return $dst
}

# Coarse block diff: returns the bounding box of visibly changed blocks.
function Get-WcuChangedBox {
  param($A, $B, [int]$GridX = 32, [int]$GridY = 18, [int]$Threshold = 12)
  if ($null -eq $A -or $null -eq $B) { return $null }
  $w = [Math]::Min($A.Width, $B.Width)
  $h = [Math]::Min($A.Height, $B.Height)
  if ($w -lt 8 -or $h -lt 8) { return $null }
  $bw = [Math]::Max(4, [int]($w / $GridX))
  $bh = [Math]::Max(4, [int]($h / $GridY))
  $step = [Math]::Max(2, [int]($bw / 6))
  $minX = -1; $minY = -1; $maxX = -1; $maxY = -1; $changed = 0
  for ($gy = 0; $gy -lt $GridY; $gy++) {
    for ($gx = 0; $gx -lt $GridX; $gx++) {
      $x0 = $gx * $bw; $y0 = $gy * $bh
      if ($x0 -ge $w -or $y0 -ge $h) { continue }
      $sum = 0.0; $n = 0
      for ($py = $y0; $py -lt [Math]::Min($y0 + $bh, $h); $py += $step) {
        for ($px = $x0; $px -lt [Math]::Min($x0 + $bw, $w); $px += $step) {
          $ca = $A.GetPixel($px, $py); $cb = $B.GetPixel($px, $py)
          $sum += ([Math]::Abs($ca.R - $cb.R) + [Math]::Abs($ca.G - $cb.G) + [Math]::Abs($ca.B - $cb.B)) / 3.0
          $n++
        }
      }
      if ($n -eq 0) { continue }
      if (($sum / $n) -ge $Threshold) {
        $changed++
        if ($minX -lt 0 -or $x0 -lt $minX) { $minX = $x0 }
        if ($minY -lt 0 -or $y0 -lt $minY) { $minY = $y0 }
        if ($x0 + $bw -gt $maxX) { $maxX = $x0 + $bw }
        if ($y0 + $bh -gt $maxY) { $maxY = $y0 + $bh }
      }
    }
  }
  if ($changed -eq 0) { return $null }
  return [ordered]@{
    x = $minX; y = $minY
    width = ($maxX - $minX); height = ($maxY - $minY)
    changedBlocks = $changed; gridX = $GridX; gridY = $GridY; threshold = $Threshold
    note = "Bounding box (image pixels) of blocks whose mean channel delta exceeded the threshold."
  }
}

function Set-WcuFrameCache {
  param([string]$Key, $Hash, $Bitmap)
  $script:WcuLastFrame[$Key] = @{ hash = $Hash; bmp = $Bitmap; at = [DateTime]::UtcNow }
  if ($script:WcuLastFrame.Count -gt 8) {
    $oldest = $script:WcuLastFrame.GetEnumerator() | Sort-Object { $_.Value.at } | Select-Object -First 1
    if ($null -ne $oldest -and $oldest.Key -ne $Key) { $script:WcuLastFrame.Remove($oldest.Key) }
  }
}

# ---------------------------------------------------------------- observe (budgeted snapshot)
function Invoke-WcuObserve {
  param($InputObject)
  $scope = [string](Get-Prop $InputObject "scope" "active_window")
  $includeScreenshot = [bool](Get-Prop $InputObject "includeScreenshot" $true)
  $includeTree = [bool](Get-Prop $InputObject "includeTree" $false)
  $maxWidth = [int](Get-Prop $InputObject "maxWidth" 1600)
  $returnMode = [string](Get-Prop $InputObject "returnMode" "auto")
  $autoMode = ($returnMode -eq "auto")
  $diffOnly = [bool](Get-Prop $InputObject "diffOnly" $false)
  $stableMs = [int](Get-Prop $InputObject "stableMs" 0)
  $cropToElement = [bool](Get-Prop $InputObject "cropToElement" $false)
  $region = Get-Prop $InputObject "region" $null

  $script:WcuCropInfo = $null
  $out = [ordered]@{ ok = $true; action = "observe"; returnMode = $returnMode }
  if ($stableMs -gt 0) { $out["stableMs"] = $stableMs }

  if ($includeTree) {
    $tree = Get-TreeResult -Scope $scope -MaxDepth ([int](Get-Prop $InputObject "maxDepth" 4)) -MaxNodes ([int](Get-Prop $InputObject "maxNodes" 200)) -InputObject $InputObject
    $out["tree"] = $tree.tree
    $out["nodeCount"] = $tree.nodeCount
    $out["truncated"] = $tree.truncated
  }
  if (-not $includeScreenshot) { return $out }

  $winEl = $null
  if ($scope -ne "desktop") {
    $explicitTarget = Has-WindowTarget $InputObject
    $winEl = Invoke-Safe { Resolve-TargetWindow $InputObject } $null
    if ($null -eq $winEl -and $explicitTarget) {
      # Never silently photograph a different window than the caller named.
      return [ordered]@{
        ok = $false; action = "observe"; refused = "target-not-found"; inputSent = $false
        requested = [ordered]@{ windowTitle = (Get-Prop $InputObject "windowTitle" $null); processId = (Get-Prop $InputObject "processId" $null); nativeWindowHandle = (Get-Prop $InputObject "nativeWindowHandle" $null) }
        hint = "No open window matched. Use window {action:'list'} / read {mode:'find'} to get an exact target, or omit the target to observe whatever is in the foreground."
      }
    }
    if ($null -eq $winEl) { $winEl = Invoke-Safe { Get-ScopeRoot $scope $InputObject } $null }
  }
  # Optional settle: wait until the pixels stop changing so the caller observes a
  # quiescent UI instead of guessing with fixed sleeps.
  if ($stableMs -gt 0) {
    # Each probe is a full window capture, so bound the loop hard: a 6 s budget with
    # a 120 ms tick used to mean ~50 screenshots per call.
    $stableBudget = [int](Get-Prop $InputObject "stableTimeoutMs" 1500)
    if ($stableBudget -gt 4000) { $stableBudget = 4000 }
    $maxProbes = [int](Get-Prop $InputObject "stableMaxProbes" 8)
    if ($maxProbes -lt 1) { $maxProbes = 1 }
    $probeCount = 0
    $swStable = [System.Diagnostics.Stopwatch]::StartNew()
    $last = $null
    $unchangedSince = 0
    while ($swStable.ElapsedMilliseconds -lt $stableBudget -and $probeCount -lt $maxProbes) {
      $probeCount++
      $prevSkip = $script:WcuSkipShotFile
      $script:WcuSkipShotFile = $true
      try { $probe = Capture-Screenshot -WindowElement $winEl -MaxWidth 240 } finally { $script:WcuSkipShotFile = $prevSkip }
      $h = $null
      if (-not [string]::IsNullOrEmpty($probe["base64"])) { $h = Get-WcuHashHex -Bytes ([Convert]::FromBase64String($probe["base64"])) }
      if ($null -ne $last -and $h -eq $last) {
        if ($unchangedSince -eq 0) { $unchangedSince = $swStable.ElapsedMilliseconds }
        if (($swStable.ElapsedMilliseconds - $unchangedSince) -ge $stableMs) { break }
      } else {
        $unchangedSince = $swStable.ElapsedMilliseconds
        $last = $h
      }
      Start-Sleep -Milliseconds 120
    }
    $settleMs = [int]$swStable.ElapsedMilliseconds
    $script:WcuLastStableProbes = $probeCount
  }

  $prevSkipShot = $script:WcuSkipShotFile
  if ($returnMode -eq "hash") { $script:WcuSkipShotFile = $true }
  try { $shot = Capture-Screenshot -WindowElement $winEl -MaxWidth $maxWidth } finally { $script:WcuSkipShotFile = $prevSkipShot }
  $bmp = Get-WcuShotBitmap -Shot $shot
  if ($null -eq $bmp) { throw "Screenshot capture returned no image data." }
  try {
    $cropRect = $null
    if ($cropToElement) {
      $el = $null
      $elId = Get-Prop $InputObject "elementId" $null
      $query = Get-Prop $InputObject "cropQuery" $null
      if ($null -ne $elId) { $el = Invoke-Safe { Resolve-Element $elId $InputObject } $null }
      elseif ($null -ne $query) {
        $treeRes = Get-TreeResult -Scope $scope -MaxDepth 8 -MaxNodes 1500 -InputObject $InputObject
        $list = New-Object System.Collections.Generic.List[object]
        Search-Tree -Node $treeRes.tree -Query ([string]$query) -ControlType "" -MaxResults 1 -Results $list
        if ($list.Count -gt 0) { $el = Invoke-Safe { Resolve-Element $list[0].id $InputObject } $null }
      }
      if ($null -ne $el) {
        $rect = Convert-Rect (Invoke-Safe { $el.Current.BoundingRectangle } $null)
        if ($null -ne $rect -and (ConvertTo-WcuInt $rect.width) -gt 0) {
          $cropRect = Convert-WcuRegionToImage -Region $rect -Shot $shot
          $out["croppedTo"] = [ordered]@{ element = $(if ($null -ne $query) { $query } else { $elId }); box = $rect }
        }
      } else {
        $out["cropWarning"] = "cropToElement requested but no element matched; returning the full capture."
      }
    } elseif ($null -ne $region) {
      $effectiveRegion = $region
      if ($region -is [string] -and $region -eq "clientArea") {
        $effectiveRegion = Get-WcuClientRectOnScreen -InputObject $InputObject
        $out["clientArea"] = $effectiveRegion
      }
      $cropRect = Convert-WcuRegionToImage -Region $effectiveRegion -Shot $shot
    }
    if ($null -ne $cropRect) {
      $cropped = Copy-WcuBitmapCrop -Bitmap $bmp -Rect $cropRect
      if ($null -ne $cropped) {
        $bmp.Dispose()
        $bmp = $cropped
        $out["region"] = $cropRect
        # The capture on disk is still the UNCROPPED frame, so a caller that reads
        # screenshot.path would see the full window. Write the crop as its own file
        # (skipped in hash mode, where no file is wanted at all).
        $cropScale = 1.0
        if ($null -ne $shot["imageScale"]) { $cropScale = [double]$shot["imageScale"] }
        if ($cropScale -le 0) { $cropScale = 1.0 }
        $cropOriginX = [double]$shot.bounds.x
        $cropOriginY = [double]$shot.bounds.y
        if ($null -ne $shot["origin"]) { $cropOriginX = [double]$shot.origin.x; $cropOriginY = [double]$shot.origin.y }
        $cropBounds = [ordered]@{
          x = [int][Math]::Round($cropOriginX + $cropRect.x / $cropScale)
          y = [int][Math]::Round($cropOriginY + $cropRect.y / $cropScale)
          width = [int][Math]::Round($cropRect.width / $cropScale)
          height = [int][Math]::Round($cropRect.height / $cropScale)
        }
        $cropFile = $null
        if ($returnMode -ne "hash") {
          $cropFile = Join-Path $env:TEMP ("windows-computer-use-crop-" + [Guid]::NewGuid().ToString("N") + ".png")
          try { $bmp.Save($cropFile, [System.Drawing.Imaging.ImageFormat]::Png) } catch { $cropFile = $null }
        }
        $script:WcuCropInfo = @{ file = $cropFile; bounds = $cropBounds }
      }
      else { $out["cropWarning"] = "region does not intersect the captured image; returning the full capture." }
    }

    $hash = Get-WcuBitmapHash -Bitmap $bmp
    $hwnd = 0
    if ($null -ne $winEl) { $hwnd = ConvertTo-WcuInt (Invoke-Safe { $winEl.Current.NativeWindowHandle } 0) }
    $key = "observe|" + $scope + "|" + $hwnd + "|" + $bmp.Width + "x" + $bmp.Height
    $prev = $script:WcuLastFrame[$key]
    if ($null -eq $prev) {
      # Fall back to the on-disk baseline so diffOnly still works after the
      # backend process was recycled (timeouts, host restart).
      $diskHash = Get-WcuBaseline -Key $key
      if ($null -ne $diskHash) { $prev = @{ hash = $diskHash; bmp = $null; at = [DateTime]::MinValue } }
    }
    $changed = $true
    $diffBox = $null
    if ($null -ne $prev) {
      $changed = ($prev.hash -ne $hash)
      if ($changed -and $diffOnly -and $null -ne $prev.bmp) { $diffBox = Get-WcuChangedBox -A $prev.bmp -B $bmp }
    }
    $pngBytes = Get-WcuPngBytes -Bitmap $bmp
    Save-WcuBaseline -Key $key -Hash $hash
    $evidence = [ordered]@{
      screenshotHash = $hash
      bytes = $pngBytes.Length
      changed = $changed
      baseline = ($null -ne $prev)
    }
    if ($null -ne $diffBox) { $evidence["changedBox"] = $diffBox }

    # A cropped frame carries crop geometry + its own file, otherwise image
    # coordinates and the returned path would describe the wrong image.
    $metaBounds = $shot.bounds
    if ($null -ne $script:WcuCropInfo -and $null -ne $script:WcuCropInfo.bounds) { $metaBounds = $script:WcuCropInfo.bounds }
    $shotMeta = [ordered]@{
      method = $shot.method
      bounds = $metaBounds
      bytes = $pngBytes.Length
      hash = $hash
      width = $bmp.Width
      height = $bmp.Height
    }
    if ($null -ne $shot["imageScale"]) { $shotMeta["imageScale"] = $shot["imageScale"] }
    if ($null -ne $shot["origin"]) { $shotMeta["origin"] = $shot["origin"] }
    # Applied last: a cropped frame describes ITS OWN geometry and file, so this
    # must not be overwritten by the shot's full-frame origin/scale.
    if ($null -ne $script:WcuCropInfo -and $null -ne $script:WcuCropInfo.bounds) {
      $shotMeta["imageScale"] = 1
      $shotMeta["origin"] = [ordered]@{ x = $script:WcuCropInfo.bounds.x; y = $script:WcuCropInfo.bounds.y }
      $shotMeta["cropped"] = $true
      if ($null -ne $script:WcuCropInfo.file) {
        $shotMeta["path"] = $script:WcuCropInfo.file
        if (Test-Path $script:WcuCropInfo.file) { $shotMeta["bytes"] = (Get-Item $script:WcuCropInfo.file).Length }
      }
    }
    if ($null -ne $shot["occludedPossible"]) { $shotMeta["occludedPossible"] = $true }
    if ($null -ne $shot["windowCaptureFailed"]) { $shotMeta["windowCaptureFailed"] = $true }

    # Transient UI (menus, dropdowns, owned dialogs) lives outside the window
    # rectangle, so a plain window capture misses it. Collect it in the SAME
    # observation, like the Codex runtime does.
    if ([bool](Get-Prop $InputObject "transient" $true)) {
      try {
        $tr = @(Get-WcuTransientWindows -InputObject $InputObject -Max ([int](Get-Prop $InputObject "transientMax" 2)))
        if ($tr.Count -gt 0) {
          $entries = @()
          foreach ($w in $tr) {
            $entry = [ordered]@{
              hwnd = $w.hwnd; title = $w.title; className = $w.className
              role = $w.role; boundingBox = $w.boundingBox
            }
            try {
              $elTr = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr](ConvertTo-WcuInt $w.hwnd))
              $shotTr = Capture-Screenshot -WindowElement $elTr -MaxWidth 700
              if ($null -ne $shotTr) {
                $entry["screenshot"] = $shotTr.path
                $entry["bytes"] = $shotTr.bytes
              }
            } catch { }
            $entries += $entry
          }
          $out["transientWindows"] = $entries
          $out["transientNote"] = "Menus/dialogs owned by the target were captured in this same state; clicks inside them are still coordinates in the target's screenshot space."
        }
      } catch { }
    }

    # Optional: capture the accessibility tree in the SAME call as the image, so
    # "what the pixels show" and "what the control tree says" are one instant.
    if ([bool](Get-Prop $InputObject "includeTree" $false)) {
      try {
        $treeArgs = [ordered]@{ includeScreenshot = $false; maxDepth = [int](Get-Prop $InputObject "treeDepth" 6) }
        foreach ($k in @("windowTitle", "processId", "nativeWindowHandle")) {
          $v = Get-Prop $InputObject $k $null
          if ($null -ne $v) { $treeArgs[$k] = $v }
        }
        $treeRes = Invoke-Action -Action "snapshot" -InputObject ([pscustomobject]$treeArgs)
        if ($null -ne $treeRes -and $null -ne $treeRes["tree"]) {
          $out["tree"] = $treeRes["tree"]
          $out["treeNodeCount"] = $treeRes["nodeCount"]
          $out["treeNote"] = "Accessibility tree captured together with the image in one call."
        }
      } catch { $out["treeError"] = $_.Exception.Message }
    }

    $obs = Register-WcuObservation -ShotMeta $shotMeta -Width $bmp.Width -Height $bmp.Height -CroppedTo $cropRect
    $out["observationId"] = $obs.id
    if ($autoMode) {
      # auto: small frames come back inline, large ones as a file path + hash so
      # the caller can decide whether the pixels are worth pulling in.
      $returnMode = $(if ($pngBytes.Length -le 150000) { "inline" } else { "file" })
      $out["returnMode"] = $returnMode
      $out["autoSelected"] = $returnMode
    }
    $out["tokenEstimate"] = [int]($pngBytes.Length / 4)
    if ($pngBytes.Length -gt 200000) {
      $out["imageBudgetHint"] = "This capture is " + [int]($pngBytes.Length / 1024) + " KB (~" + [int]($pngBytes.Length / 4) + " tokens when inlined). Prefer returnMode:'hash', a region, cropToElement or diffOnly when you only need to know whether anything changed."
    }
    if ($stableMs -gt 0) {
      $out["settleMs"] = $settleMs
      $out["stable"] = $true
      $out["probeCount"] = $script:WcuLastStableProbes
      $out["stableBudgetMs"] = $stableBudget
    }
    $out["changed"] = $changed
    $out["evidence"] = $evidence

    if ($diffOnly -and -not $changed) {
      $out["screenshot"] = $shotMeta
      $out["note"] = "No visible change since the previous observation of this target; image omitted (diffOnly)."
      Set-WcuFrameCache -Key $key -Hash $hash -Bitmap $bmp
      return $out
    }

    if ($null -ne $script:WcuCropInfo -and $null -ne $script:WcuCropInfo.file) {
      $shotMeta["path"] = $script:WcuCropInfo.file
    } else {
      $shotMeta["path"] = $shot.path
    }
    if ($returnMode -eq "file") {
      $out["screenshot"] = $shotMeta
      $out["note"] = "Image written to path; base64 omitted (returnMode:'file')."
      Set-WcuFrameCache -Key $key -Hash $hash -Bitmap $bmp
      return $out
    }
    if ($returnMode -eq "hash") {
      $out["screenshot"] = $shotMeta
      $out["note"] = "Hash-only mode: no image bytes returned (returnMode:'hash')."
      Set-WcuFrameCache -Key $key -Hash $hash -Bitmap $bmp
      return $out
    }
    $shotMeta["base64"] = [Convert]::ToBase64String($pngBytes)
    $out["screenshot"] = $shotMeta
    # keep a working copy for the next diff, then release the returned one
    $keep = Copy-WcuBitmapCrop -Bitmap $bmp -Rect ([ordered]@{ x = 0; y = 0; width = $bmp.Width; height = $bmp.Height })
    Set-WcuFrameCache -Key $key -Hash $hash -Bitmap $keep
    return $out
  } finally { $bmp.Dispose() }
}

# Cheap capture used for before/after evidence.
function Invoke-WcuCaptureHash {
  param($InputObject)
  $winEl = Invoke-Safe { Resolve-TargetWindow $InputObject } $null
  $shot = Capture-Screenshot -WindowElement $winEl -MaxWidth 480
  if ([string]::IsNullOrEmpty($shot["base64"])) { throw "capture_hash could not capture the target." }
  $hash = Get-WcuHashHex -Bytes ([Convert]::FromBase64String($shot["base64"]))
  return [ordered]@{
    ok = $true
    action = "capture_hash"
    hash = $hash
    bytes = $shot.bytes
    method = $shot.method
    bounds = $shot.bounds
  }
}

# ---------------------------------------------------------------- verify_state
function Test-WcuPredicate {
  param($Predicate, $InputObject)
  $kind = [string](Get-Prop $Predicate "kind" "")
  $value = Get-Prop $Predicate "value" $null
  $res = [ordered]@{ kind = $kind; satisfied = $false }
  switch ($kind) {
    "window_exists" {
      $hasTarget = $false
      if ($null -ne $InputObject) {
        $names = $InputObject.PSObject.Properties.Name
        if (($names -contains 'windowTitle') -and ($null -ne $InputObject.windowTitle)) { $hasTarget = $true }
        if (($names -contains 'processId') -and ($null -ne $InputObject.processId)) { $hasTarget = $true }
        if (($names -contains 'nativeWindowHandle') -and ($null -ne $InputObject.nativeWindowHandle)) { $hasTarget = $true }
      }
      if ($hasTarget) {
        $el = Invoke-Safe { Resolve-TargetWindow $InputObject } $null
        $res["satisfied"] = ($null -ne $el)
        if ($null -ne $el) { $res["evidence"] = [ordered]@{ hwnd = (ConvertTo-WcuInt (Invoke-Safe { $el.Current.NativeWindowHandle } 0)) } }
      } else {
        $fg = Get-WcuForegroundIdentity
        $res["satisfied"] = ($null -ne $fg)
        if ($null -ne $fg) { $res["evidence"] = [ordered]@{ target = $fg; note = "no target was supplied, so this checks the foreground window" } }
      }
    }
    "title_contains" {
      $id = Get-WcuTargetIdentity -InputObject $InputObject
      $title = ""
      if ($null -ne $id) { $title = [string]$id.title }
      $res["satisfied"] = ($title.Contains([string]$value))
      $res["evidence"] = [ordered]@{ title = $title; expected = [string]$value }
    }
    "class_equals" {
      $id = Get-WcuTargetIdentity -InputObject $InputObject
      $cls = ""
      if ($null -ne $id) { $cls = [string]$id.className }
      $res["satisfied"] = ($cls -eq [string]$value)
      $res["evidence"] = [ordered]@{ className = $cls; expected = [string]$value }
    }
    "process_running" {
      $name = Get-Prop $Predicate "name" $null
      $procId = ConvertTo-WcuInt (Get-Prop $Predicate "processId" 0)
      $procs = @()
      if ($procId -gt 0) {
        $one = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($null -ne $one) { $procs = @($one) }
      } elseif ($null -ne $name) {
        $procs = @(Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension([string]$name)) -ErrorAction SilentlyContinue)
      }
      $res["satisfied"] = ($procs.Count -gt 0)
      if ($procs.Count -eq 1) { $res["evidence"] = [ordered]@{ pid = $procs[0].Id; processName = $procs[0].ProcessName } }
      elseif ($procs.Count -gt 1) { $res["evidence"] = [ordered]@{ count = $procs.Count; processes = @($procs | ForEach-Object { [ordered]@{ pid = $_.Id; processName = $_.ProcessName } }) } }
    }
    "element_present" {
      $q = [string](Get-Prop $Predicate "query" $value)
      $scope = [string](Get-Prop $Predicate "scope" (Get-Prop $InputObject "scope" "active_window"))
      $treeRes = Get-TreeResult -Scope $scope -MaxDepth ([int](Get-Prop $Predicate "maxDepth" 8)) -MaxNodes ([int](Get-Prop $Predicate "maxNodes" 1500)) -InputObject $InputObject
      $list = New-Object System.Collections.Generic.List[object]
      Search-Tree -Node $treeRes.tree -Query $q -ControlType ([string](Get-Prop $Predicate "controlType" "")) -MaxResults 5 -Results $list
      $res["satisfied"] = ($list.Count -gt 0)
      $res["evidence"] = [ordered]@{ query = $q; matches = @($list.ToArray()); scannedNodes = $treeRes.nodeCount }
    }
    "element_absent" {
      $q = [string](Get-Prop $Predicate "query" $value)
      $scope = [string](Get-Prop $Predicate "scope" (Get-Prop $InputObject "scope" "active_window"))
      $treeRes = Get-TreeResult -Scope $scope -MaxDepth ([int](Get-Prop $Predicate "maxDepth" 8)) -MaxNodes ([int](Get-Prop $Predicate "maxNodes" 1500)) -InputObject $InputObject
      $list = New-Object System.Collections.Generic.List[object]
      Search-Tree -Node $treeRes.tree -Query $q -ControlType ([string](Get-Prop $Predicate "controlType" "")) -MaxResults 5 -Results $list
      $res["satisfied"] = ($list.Count -eq 0)
      $res["evidence"] = [ordered]@{ query = $q; scannedNodes = $treeRes.nodeCount }
    }
    "element_value" {
      $el = $null
      $elId = Get-Prop $Predicate "elementId" $null
      $q = Get-Prop $Predicate "query" $null
      $scope = [string](Get-Prop $Predicate "scope" (Get-Prop $InputObject "scope" "active_window"))
      if ($null -ne $elId) { $el = Invoke-Safe { Resolve-Element $elId $InputObject } $null }
      elseif ($null -ne $q) {
        $treeRes = Get-TreeResult -Scope $scope -MaxDepth 8 -MaxNodes 1500 -InputObject $InputObject
        $list = New-Object System.Collections.Generic.List[object]
        Search-Tree -Node $treeRes.tree -Query ([string]$q) -ControlType "" -MaxResults 1 -Results $list
        if ($list.Count -gt 0) { $el = Invoke-Safe { Resolve-Element $list[0].id $InputObject } $null }
      }
      $actual = $null
      if ($null -ne $el) { $actual = Invoke-Safe { Get-ValueText $el } $null }
      $want = [string]$value
      $mode = [string](Get-Prop $Predicate "match" "equals")
      if ($mode -eq "contains") { $res["satisfied"] = ($null -ne $actual -and ([string]$actual).Contains($want)) }
      else { $res["satisfied"] = ([string]$actual -eq $want) }
      $res["evidence"] = [ordered]@{ value = $actual; expected = $want; match = $mode }
    }
    "image_changed" {
      $cap = Invoke-WcuCaptureHash -InputObject $InputObject
      $key = "verify|" + [string](Get-Prop $Predicate "key" "default")
      $prev = $script:WcuLastFrame[$key]
      if ($null -eq $prev) {
        $res["satisfied"] = $false
        $res["evidence"] = [ordered]@{ hash = $cap.hash; baseline = "established on this call; re-run to compare" }
      } else {
        $res["satisfied"] = ($prev.hash -ne $cap.hash)
        $res["evidence"] = [ordered]@{ previousHash = $prev.hash; hash = $cap.hash }
      }
      $script:WcuLastFrame[$key] = @{ hash = $cap.hash; bmp = $null; at = [DateTime]::UtcNow }
    }
    default { $res["error"] = "unknown predicate kind: " + $kind }
  }
  return $res
}

function Invoke-WcuVerifyState {
  param($InputObject)
  $predicates = @(Get-Prop $InputObject "predicates" @())
  if ($predicates.Count -eq 0) {
    $single = Get-Prop $InputObject "predicate" $null
    if ($null -ne $single) { $predicates = @($single) }
  }
  if ($predicates.Count -eq 0) { throw "verify_state requires 'predicates' (array) or 'predicate' (object)." }
  $timeoutMs = [int](Get-Prop $InputObject "timeoutMs" 0)
  $intervalMs = [int](Get-Prop $InputObject "intervalMs" 400)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $attempts = 0
  $results = @()
  $allPassed = $false
  while ($true) {
    $attempts++
    $results = @()
    $allPassed = $true
    foreach ($p in $predicates) {
      $r = Test-WcuPredicate -Predicate $p -InputObject $InputObject
      $results += $r
      if (-not $r.satisfied) { $allPassed = $false }
    }
    if ($allPassed) { break }
    if ($sw.ElapsedMilliseconds -ge $timeoutMs) { break }
    Start-Sleep -Milliseconds $intervalMs
  }
  return [ordered]@{
    ok = $true
    action = "verify_state"
    passed = $allPassed
    attempts = $attempts
    elapsedMs = [int]$sw.ElapsedMilliseconds
    results = $results
  }
}


# ============================================================================
# M3: virtual cursor overlay / delivery ladder / red lines
# ============================================================================

function Get-WcuCursorCmdPath { return (Join-Path $env:TEMP "windows-computer-use-cursor-cmd.json") }
function Get-WcuCursorStatePath { return (Join-Path $env:TEMP "windows-computer-use-cursor-state.json") }

function Get-WcuCursorState {
  $p = Get-WcuCursorStatePath
  if (-not (Test-Path $p)) { return $null }
  try { return (Get-Content $p -Raw | ConvertFrom-Json) } catch { return $null }
}

function Ensure-WcuCursorHelper {
  $state = Get-WcuCursorState
  if ($null -ne $state -and $null -ne $state.pid) {
    $proc = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    if ($null -ne $proc -and $proc.ProcessName -eq "powershell") { return [int]$state.pid }
  }
  $helper = Join-Path $PSScriptRoot "agent-cursor.ps1"
  if (-not (Test-Path $helper)) { throw "agent-cursor.ps1 is missing next to windows-uia-ext.ps1." }
  $proc = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $helper,
    "-CommandPath", (Get-WcuCursorCmdPath), "-StatePath", (Get-WcuCursorStatePath)
  ) -WindowStyle Hidden -PassThru
  # Wait until the helper publishes its pid (it draws on the first tick).
  $deadline = [DateTime]::UtcNow.AddMilliseconds(4000)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 150
    $s = Get-WcuCursorState
    if ($null -ne $s -and [int]$s.pid -eq [int]$proc.Id) { return [int]$proc.Id }
  }
  return [int]$proc.Id
}

function Send-WcuCursorCommand {
  param($Command)
  $prev = Get-WcuCursorState
  $seq = 0
  if ($null -ne $prev -and $null -ne $prev.seq) { $seq = [int]$prev.seq }
  $seq = $seq + 1
  $helperPid = Ensure-WcuCursorHelper
  $payload = [ordered]@{
    seq = $seq
    enabled = $(if ($null -ne $Command.enabled) { [bool]$Command.enabled } else { $true })
    x = $Command.x
    y = $Command.y
    speed = $Command.speed
    click = $(if ($null -ne $Command.click -and [string]$Command.click -eq "double") { "double" } elseif ($Command.click) { "single" } else { "none" })
    theme = $Command.theme
    label = $Command.label
    trail = [bool]$Command.trail
    reducedMotion = [bool]$Command.reducedMotion
    clearTrail = [bool]$Command.clearTrail
    quit = [bool]$Command.quit
    ts = (Get-Date).ToString("o")
  }
  ($payload | ConvertTo-Json -Compress) | Set-Content -Path (Get-WcuCursorCmdPath) -Encoding UTF8
  Start-Sleep -Milliseconds 120
  $now = Get-WcuCursorState
  return [ordered]@{ helperPid = $helperPid; seq = $seq; payload = $payload; state = $now }
}

function Invoke-WcuAgentCursor {
  param($InputObject)
  $stateOnly = [bool](Get-Prop $InputObject "state" $false)
  $quit = [bool](Get-Prop $InputObject "quit" $false)
  if ($stateOnly) {
    $s = Get-WcuCursorState
    $alive = $false
    if ($null -ne $s -and $null -ne $s.pid) { $alive = ($null -ne (Get-Process -Id ([int]$s.pid) -ErrorAction SilentlyContinue)) }
    return [ordered]@{ ok = $true; action = "agent_cursor"; helperAlive = $alive; state = $s; cmdPath = (Get-WcuCursorCmdPath); statePath = (Get-WcuCursorStatePath) }
  }
  $cmd = [pscustomobject]@{
    enabled = Get-Prop $InputObject "enabled" $null
    x = Get-Prop $InputObject "x" $null
    y = Get-Prop $InputObject "y" $null
    speed = Get-Prop $InputObject "speed" $null
    click = Get-Prop $InputObject "click" $false
    theme = Get-Prop $InputObject "theme" $null
    label = Get-Prop $InputObject "label" $null
    trail = Get-Prop $InputObject "trail" $false
    reducedMotion = Get-Prop $InputObject "reducedMotion" $false
    clearTrail = Get-Prop $InputObject "clearTrail" $false
    quit = $quit
  }
  $r = Send-WcuCursorCommand -Command $cmd
  $out = [ordered]@{
    ok = $true
    action = "agent_cursor"
    helperPid = $r.helperPid
    seq = $r.seq
    enabled = $r.payload.enabled
    x = $r.payload.x
    y = $r.payload.y
    theme = $r.payload.theme
    realPointerMoved = $false
    note = "The overlay cursor is drawn by a separate click-through window; the real mouse pointer and focus are untouched."
  }
  if ($quit) { $out["note"] = "Overlay helper asked to quit; the window closes on its next tick." }
  return $out
}

function Test-WcuRedLine {
  param($Identity, [string]$Action = "")
  if ([string]$env:WCU_ALLOW_REDLINES -eq "1") { return $null }
  if ($null -eq $Identity) { return $null }
  $proc = ([string]$Identity.processName).ToLowerInvariant()
  $cls = [string]$Identity.className
  $title = [string]$Identity.title
  $denyProc = @("cmd", "powershell", "pwsh", "windowsterminal", "wt", "conhost", "openconsole", "mintty",
                "bash", "wsl", "regedit", "taskmgr", "mmc", "consent", "logonui", "credwiz",
                "keepass", "1password", "bitwarden", "lastpass", "dashlane", "procexp", "procmon")
  foreach ($p in $denyProc) {
    if ($proc -eq $p -or $proc.StartsWith($p)) {
      return [ordered]@{ rule = "never-automate-process"; process = $proc; reason = "Process '" + $proc + "' is a terminal, credential store, or system tooling: automation is blocked by policy." }
    }
  }
  $denyClass = @("ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "TaskManagerWindow", "Credential Dialog Xaml Host")
  foreach ($c in $denyClass) {
    if ($cls -eq $c) { return [ordered]@{ rule = "never-automate-window-class"; className = $cls; reason = "Window class '" + $cls + "' is blocked by policy." } }
  }
  if ($cls -eq "#32770" -and ($title -match "\u8fd0\u884c|^Run")) {
    return [ordered]@{ rule = "never-automate-run-dialog"; title = $title; reason = "The Windows Run dialog is blocked by policy." }
  }
  if ($title -match "\u7528\u6237\u8d26\u6237\u63a7\u5236|User Account Control") {
    return [ordered]@{ rule = "uac-prompt"; title = $title; reason = "A UAC elevation prompt is on screen; policy forbids automating it." }
  }
  # Operator supplied additions: %USERPROFILE%\.dsh\wincu-redlines.json
  $cfg = Get-WcuRedLineConfig
  if ($null -ne $cfg) {
    foreach ($p in @($cfg.processes)) {
      if (-not $p) { continue }
      $pl = ([string]$p).ToLowerInvariant()
      if ($proc -eq $pl -or $proc.StartsWith($pl)) {
        return [ordered]@{ rule = "config-process"; process = $proc; reason = "Process '" + $proc + "' is listed in the operator's wincu-redlines.json." }
      }
    }
    foreach ($c in @($cfg.classes)) {
      if ($c -and $cls -eq [string]$c) {
        return [ordered]@{ rule = "config-class"; className = $cls; reason = "Window class '" + $cls + "' is listed in the operator's wincu-redlines.json." }
      }
    }
    foreach ($t in @($cfg.titles)) {
      if ($t -and $title -like ("*" + [string]$t + "*")) {
        return [ordered]@{ rule = "config-title"; title = $title; reason = "The window title matches '" + $t + "' from the operator's wincu-redlines.json." }
      }
    }
  }
  # Rename-proof heuristic: a process that owns a console window is console
  # tooling whatever its executable is called.
  $pidTarget = ConvertTo-WcuInt (Invoke-Safe { $Identity.processId } 0)
  if ($pidTarget -gt 0) {
    try {
      $wins = Get-NativeWindowList -IncludeInvisible $true -MaxWindows 200
      foreach ($w in $wins) {
        if ((ConvertTo-WcuInt $w.processId) -eq $pidTarget -and ([string]$w.className) -eq "ConsoleWindowClass") {
          return [ordered]@{ rule = "console-host-heuristic"; process = $proc; reason = "Process '" + $proc + "' owns a console window; automation stays blocked even for renamed console hosts." }
        }
      }
    } catch { }
  }
  return $null
}

function Get-WcuTargetHwnd {
  param($InputObject)
  $el = Invoke-Safe { Resolve-TargetWindow $InputObject } $null
  if ($null -ne $el) { return (ConvertTo-WcuInt (Invoke-Safe { $el.Current.NativeWindowHandle } 0)) }
  Initialize-WcuExtNative
  return (ConvertTo-WcuInt ([WcuExt.Native]::GetForegroundWindow()))
}

function Invoke-WcuVirtualClick {
  param($InputObject)
  $x = ConvertTo-WcuInt (Get-Prop $InputObject "x" -1)
  $y = ConvertTo-WcuInt (Get-Prop $InputObject "y" -1)
  if ($x -lt 0 -or $y -lt 0) { throw "virtual_click requires x and y in screen pixels." }
  $button = [string](Get-Prop $InputObject "button" "left")
  $durationMs = [int](Get-Prop $InputObject "durationMs" 260)
  $allowForeground = [bool](Get-Prop $InputObject "allowForegroundFallback" $false)
  $identity = Get-WcuTargetIdentity -InputObject $InputObject
  $red = Test-WcuRedLine -Identity $identity -Action "virtual_click"
  if ($null -ne $red) {
    return [ordered]@{ ok = $false; action = "virtual_click"; refused = "red-line"; detail = $red; target = $identity; inputSent = $false }
  }
  $dbl = [bool](Get-Prop $InputObject "doubleClick" $false)
  $hasExplicitTarget = ($null -ne (Get-Prop $InputObject "windowTitle" $null)) -or
                       ($null -ne (Get-Prop $InputObject "processId" $null)) -or
                       ($null -ne (Get-Prop $InputObject "nativeWindowHandle" $null))
  $hwnd = 0
  $hwndSource = "target"
  if ($hasExplicitTarget) {
    $hwnd = Get-WcuTargetHwnd -InputObject $InputObject
  } else {
    # No window named: the POINT is the intent, so the window under it wins over
    # whatever happens to be in the foreground.
    $hwnd = Get-WcuWindowAtPoint -X $x -Y $y
    $hwndSource = "window-from-point"
    if ($hwnd -le 0) { $hwnd = Get-WcuTargetHwnd -InputObject $InputObject; $hwndSource = "foreground" }
  }
  if ($hwnd -le 0) {
    return [ordered]@{
      ok = $false
      action = "virtual_click"
      refused = "no-input-surface"
      x = $x; y = $y
      inputSent = $false
      hint = "No window owns that point (desktop/UWP surface without a window). Post a virtual click at a point inside a window, or use the real 'click' tool if this surface must be driven."
    }
  }
  $label = [string](Get-Prop $InputObject "label" $(if ($dbl) { "double click" } else { "click" }))
  $cursor = Send-WcuCursorCommand -Command ([pscustomobject]@{
    enabled = $true; x = $x; y = $y
    click = $(if ($dbl) { "double" } else { $true })
    theme = (Get-Prop $InputObject "theme" $null)
    label = $label
    trail = [bool](Get-Prop $InputObject "trail" $false)
    reducedMotion = [bool](Get-Prop $InputObject "reducedMotion" $false)
  })
  Start-Sleep -Milliseconds ([Math]::Min(600, [Math]::Max(60, $durationMs)))
  $posted = $false
  $clickCount = $(if ($dbl) { 2 } else { 1 })
  try { $posted = Post-BackgroundClick -Hwnd ([long]$hwnd) -X $x -Y $y -Button $button -Count $clickCount } catch { $posted = $false }
  $out = [ordered]@{
    ok = $true
    action = "virtual_click"
    delivered = "postmessage-background"
    posted = $posted
    verified = $false
    x = $x
    y = $y
    button = $button
    targetHwnd = $hwnd
    targetHwndSource = $hwndSource
    clickCount = $clickCount
    cursor = [ordered]@{ mode = "virtual-overlay"; helperPid = $cursor.helperPid; realPointerMoved = $false; label = $label }
    evidence = [ordered]@{
      verification = "not verified: a posted click can be dropped (Chromium/Electron/UWP/WinUI). Call verify_state to confirm the effect."
      foregroundFallback = $(if ($allowForeground) { "allowed but NOT used automatically: a refusal never authorizes a foreground retry; call click with dispatch:'foreground' explicitly." } else { "disabled" })
    }
  }
  return $out
}

function Invoke-WcuVirtualMove {
  param($InputObject)
  $x = ConvertTo-WcuInt (Get-Prop $InputObject "x" -1)
  $y = ConvertTo-WcuInt (Get-Prop $InputObject "y" -1)
  if ($x -lt 0 -or $y -lt 0) { throw "virtual_move requires x and y in screen pixels." }
  $label = [string](Get-Prop $InputObject "label" "move")
  $trail = $true
  if ($null -ne (Get-Prop $InputObject "trail" $null)) { $trail = [bool](Get-Prop $InputObject "trail" $false) }
  $cursor = Send-WcuCursorCommand -Command ([pscustomobject]@{
    enabled = $true; x = $x; y = $y
    theme = (Get-Prop $InputObject "theme" $null)
    label = $label
    trail = $trail
    reducedMotion = [bool](Get-Prop $InputObject "reducedMotion" $false)
    clearTrail = [bool](Get-Prop $InputObject "clearTrail" $false)
  })
  return [ordered]@{
    ok = $true
    action = "virtual_move"
    x = $x
    y = $y
    helperPid = $cursor.helperPid
    realPointerMoved = $false
    note = "Overlay cursor repositioned. No input was sent and the real pointer did not move."
  }
}


# ============================================================================
# M5: vision fallback (OCR preprocessing + optional VLM describe)
# ============================================================================

function Get-WcuMeanLuma {
  param($Bitmap)
  $stepX = [Math]::Max(1, [int]($Bitmap.Width / 48))
  $stepY = [Math]::Max(1, [int]($Bitmap.Height / 27))
  $sum = 0.0; $n = 0
  for ($y = 0; $y -lt $Bitmap.Height; $y += $stepY) {
    for ($x = 0; $x -lt $Bitmap.Width; $x += $stepX) {
      $c = $Bitmap.GetPixel($x, $y)
      $sum += (0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
      $n++
    }
  }
  if ($n -eq 0) { return 128.0 }
  return ($sum / $n)
}

function Get-WcuPreprocessedBitmap {
  param($Bitmap, [string]$Mode = "auto", [double]$Scale = 2.0)
  $invert = $false
  $contrast = 1.0
  switch ($Mode) {
    "none" { }
    "invert" { $invert = $true }
    "contrast" { $contrast = 1.45 }
    "upscale2x" { }
    default {
      # auto: dark themes OCR badly, so invert when the frame is dark, and
      # always boost contrast a little.
      $luma = Get-WcuMeanLuma -Bitmap $Bitmap
      if ($luma -lt 96) { $invert = $true }
      $contrast = 1.35
    }
  }
  $w = [int][Math]::Round($Bitmap.Width * $Scale)
  $h = [int][Math]::Round($Bitmap.Height * $Scale)
  if ($w -lt 16) { $w = 16 }
  if ($h -lt 16) { $h = 16 }
  $dst = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($dst)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $m = New-Object System.Drawing.Imaging.ColorMatrix
    if ($invert) {
      $m.Matrix00 = -1 * $contrast; $m.Matrix11 = -1 * $contrast; $m.Matrix22 = -1 * $contrast
      $m.Matrix33 = 1.0
      $m.Matrix40 = 1.0; $m.Matrix41 = 1.0; $m.Matrix42 = 1.0
    } else {
      $t = (1.0 - $contrast) / 2.0
      $m.Matrix00 = $contrast; $m.Matrix11 = $contrast; $m.Matrix22 = $contrast
      $m.Matrix33 = 1.0
      $m.Matrix40 = $t; $m.Matrix41 = $t; $m.Matrix42 = $t
    }
    $attrs.SetColorMatrix($m)
    $rect = [System.Drawing.Rectangle]::new(0, 0, $w, $h)
    $g.DrawImage($Bitmap, $rect, 0, 0, $Bitmap.Width, $Bitmap.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
  } finally { $g.Dispose() }
  return @{ bitmap = $dst; invert = $invert; contrast = $contrast; scale = $Scale }
}

function Invoke-WcuDescribe {
  param($InputObject)
  $scope = [string](Get-Prop $InputObject "scope" "active_window")
  $question = [string](Get-Prop $InputObject "question" "")
  $backend = [string](Get-Prop $InputObject "backend" "auto")
  $mode = [string](Get-Prop $InputObject "preprocess" "auto")
  $scale = [double](Get-Prop $InputObject "scale" 2.0)
  $maxWidth = [int](Get-Prop $InputObject "maxWidth" 1600)
  $maxLines = [int](Get-Prop $InputObject "maxLines" 40)

  $winEl = $null
  if ($scope -ne "desktop") {
    $explicitTarget = Has-WindowTarget $InputObject
    $winEl = Invoke-Safe { Resolve-TargetWindow $InputObject } $null
    if ($null -eq $winEl -and $explicitTarget) {
      return [ordered]@{ ok = $false; action = "describe"; refused = "target-not-found"; inputSent = $false; hint = "No open window matched the named target; list windows first." }
    }
    if ($null -eq $winEl) { $winEl = Invoke-Safe { Get-ScopeRoot $scope $InputObject } $null }
  }
  $prevSkipShot = $script:WcuSkipShotFile
  if ($returnMode -eq "hash") { $script:WcuSkipShotFile = $true }
  try { $shot = Capture-Screenshot -WindowElement $winEl -MaxWidth $maxWidth } finally { $script:WcuSkipShotFile = $prevSkipShot }
  $bmp = Get-WcuShotBitmap -Shot $shot
  if ($null -eq $bmp) { throw "describe could not capture the target." }
  $prepPath = $null
  try {
    $region = Get-Prop $InputObject "region" $null
    if ($null -ne $region) {
      $rect = Convert-WcuRegionToImage -Region $region -Shot $shot
      $cropped = Copy-WcuBitmapCrop -Bitmap $bmp -Rect $rect
      if ($null -ne $cropped) { $bmp.Dispose(); $bmp = $cropped }
    }
    $prep = Get-WcuPreprocessedBitmap -Bitmap $bmp -Mode $mode -Scale $scale
    $prepBmp = $prep.bitmap
    try {
      $prepPath = Join-Path $env:TEMP ("wcu-describe-" + [Guid]::NewGuid().ToString("N") + ".png")
      $prepBmp.Save($prepPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $prepBmp.Dispose() }

    $out = [ordered]@{
      ok = $true
      action = "describe"
      target = (Get-WcuTargetIdentity -InputObject $InputObject)
      image = $shot.path
      preprocessed = $prepPath
      preprocess = [ordered]@{ mode = $mode; invert = $prep.invert; contrast = $prep.contrast; scale = $prep.scale }
      source = $(if ($null -ne $winEl) { "window" } else { "desktop" })
    }
    if ($null -ne $shot["occludedPossible"]) { $out["occludedPossible"] = $true }

    if ($backend -eq "vlm") {
      $out["note"] = "backend:'vlm' requested but no VLM endpoint is configured (set WCU_VLM_URL / WCU_VLM_KEY / WCU_VLM_MODEL in the host environment)."
    }
    if ($backend -ne "vlm") {
      $ocr = $null
      try { $ocr = Invoke-Ocr -PngPath $prepPath } catch { $out["ocrError"] = $_.Exception.Message }
      if ($null -ne $ocr) {
        $lines = @()
        $i = 0
        foreach ($l in $ocr.lines) {
          if ($i -ge $maxLines) { break }
          $lines += $l
          $i++
        }
        $out["ocr"] = [ordered]@{
          language = $ocr.lang
          charCount = ([string]$ocr.text).Length
          lineCount = @($ocr.lines).Count
          lines = $lines
          truncated = (@($ocr.lines).Count -gt $lines.Count)
        }
        $out["text"] = $ocr.text
        if (([string]$ocr.text).Length -eq 0) {
          $out["note"] = "OCR returned no text. The window may be a canvas/game view (nothing textual), or the theme defeats OCR even after preprocessing."
        }
      }
    }

    if (-not [string]::IsNullOrEmpty($env:WCU_VLM_URL)) {
      try {
        $bytes = [System.IO.File]::ReadAllBytes($prepPath)
        $b64 = [Convert]::ToBase64String($bytes)
        $model = [string]$env:WCU_VLM_MODEL
        if ([string]::IsNullOrEmpty($model)) { $model = "gpt-4o-mini" }
        $prompt = $question
        if ([string]::IsNullOrEmpty($prompt)) { $prompt = "Describe this screenshot of a Windows application: what is on screen, which controls are visible, and what state are they in? Be concise." }
        $payload = @{
          model = $model
          max_tokens = 700
          messages = @(
            @{
              role = "user"
              content = @(
                @{ type = "text"; text = $prompt },
                @{ type = "image_url"; image_url = @{ url = ("data:image/png;base64," + $b64) } }
              )
            }
          )
        } | ConvertTo-Json -Depth 12
        $headers = @{ "Content-Type" = "application/json" }
        if (-not [string]::IsNullOrEmpty($env:WCU_VLM_KEY)) { $headers["Authorization"] = "Bearer " + $env:WCU_VLM_KEY }
        $resp = Invoke-RestMethod -Uri $env:WCU_VLM_URL -Method Post -Headers $headers -Body $payload -TimeoutSec 90
        $vlmText = $resp.choices[0].message.content
        $out["vlm"] = [ordered]@{ model = $model; text = $vlmText }
        $out["backend"] = "vlm"
      } catch {
        $out["vlmError"] = $_.Exception.Message
        $out["backend"] = "ocr"
      }
    } else {
      if (-not $out.Contains("backend")) { $out["backend"] = "ocr" }
    }
    return $out
  } finally {
    $bmp.Dispose()
  }
}


# ---------------------------------------------------------------- coordinate spaces
# Convert a point between screen / window-local / client-local spaces. Window-local
# is relative to the window rect (incl. borders); client-local is relative to the
# client area - the two conventions apps like Mine-imator or Paint expose.
function Resolve-WcuPointSpace {
  param($InputObject, [int]$X, [int]$Y, [string]$Space = "window")
  Initialize-WcuExtNative
  $el = Invoke-Safe { Resolve-TargetWindow $InputObject } $null
  $hwnd = 0
  if ($null -ne $el) { $hwnd = ConvertTo-WcuInt (Invoke-Safe { $el.Current.NativeWindowHandle } 0) }
  if ($hwnd -le 0) { $hwnd = ConvertTo-WcuInt ([WcuExt.Native]::GetForegroundWindow()) }
  if ($hwnd -le 0) { throw "space:'" + $Space + "' needs a resolvable target window (pass windowTitle/processId/nativeWindowHandle)." }

  $rect = Invoke-Safe { Get-FreshWindowRect $el } $null
  if ($null -eq $rect) {
    $r = New-Object WcuExt.Native+RECT
    if ([WcuExt.Native]::GetWindowRect([IntPtr]$hwnd, [ref]$r)) {
      $rect = [ordered]@{ x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
    }
  }
  if ($null -eq $rect) { throw "space:'" + $Space + "' could not read the window rectangle for hwnd " + $hwnd + "." }

  $screenX = $X
  $screenY = $Y
  if ($Space -eq "window") {
    $screenX = (ConvertTo-WcuInt $rect.x) + $X
    $screenY = (ConvertTo-WcuInt $rect.y) + $Y
  } elseif ($Space -eq "client") {
    $pt = New-Object WcuExt.Native+POINT
    $pt.X = $X
    $pt.Y = $Y
    if (-not [WcuExt.Native]::ClientToScreen([IntPtr]$hwnd, [ref]$pt)) {
      throw "space:'client' ClientToScreen failed for hwnd " + $hwnd + "."
    }
    $screenX = $pt.X
    $screenY = $pt.Y
  } elseif ($Space -ne "screen") {
    throw "space must be 'screen', 'window' or 'client' (got '" + $Space + "')."
  }

  $winPt = New-Object WcuExt.Native+POINT
  $winPt.X = $screenX
  $winPt.Y = $screenY
  [void][WcuExt.Native]::ScreenToClient([IntPtr]$hwnd, [ref]$winPt)

  return [ordered]@{
    screen = [ordered]@{ x = $screenX; y = $screenY }
    windowLocal = [ordered]@{ x = ($screenX - (ConvertTo-WcuInt $rect.x)); y = ($screenY - (ConvertTo-WcuInt $rect.y)) }
    clientLocal = [ordered]@{ x = $winPt.X; y = $winPt.Y }
    windowRect = $rect
    requested = [ordered]@{ x = $X; y = $Y; space = $Space }
    hwnd = $hwnd
  }
}

# Find the top-level window that owns a screen point (fallback for callers that
# have no window target: the virtual cursor still needs somewhere to post to).
function Get-WcuWindowAtPoint {
  param([int]$X, [int]$Y)
  Initialize-WcuExtNative
  $pt = New-Object WcuExt.Native+POINT
  $pt.X = $X
  $pt.Y = $Y
  $hwnd = ConvertTo-WcuInt ([WcuExt.Native]::WindowFromPoint($pt))
  if ($hwnd -le 0) { return 0 }
  # GA_ROOT resolves child -> top-level in one step; the GetParent walk below can
  # stop on a window OWNER, which made child windows look like foreign windows.
  $root = ConvertTo-WcuInt (Invoke-Safe { [WcuExt.Native]::GetAncestor([IntPtr]$hwnd, 2) } ([IntPtr]::Zero))
  if ($root -gt 0) { return $root }
  # walk up to the top-level window
  $cur = $hwnd
  for ($i = 0; $i -lt 8; $i++) {
    $parent = Invoke-Safe { [WcuExt.Native]::GetParent([IntPtr]$cur) } ([IntPtr]::Zero)
    if ($null -eq $parent -or $parent -eq [IntPtr]::Zero) { break }
    $cur = ConvertTo-WcuInt $parent
  }
  return $cur
}

function Get-WcuClientRectOnScreen {
  param($InputObject)
  Initialize-WcuExtNative
  $hwnd = Get-WcuTargetHwnd -InputObject $InputObject
  if ($hwnd -le 0) { throw "clientArea region needs a resolvable target window." }
  $r = New-Object WcuExt.Native+RECT
  [void][WcuExt.Native]::GetClientRect([IntPtr]$hwnd, [ref]$r)
  $pt = New-Object WcuExt.Native+POINT
  $pt.X = 0; $pt.Y = 0
  [void][WcuExt.Native]::ClientToScreen([IntPtr]$hwnd, [ref]$pt)
  return [ordered]@{ x = $pt.X; y = $pt.Y; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
}

function Get-WcuRedLineConfig {
  $paths = @()
  if ($env:WCU_REDLINES_FILE) { $paths += $env:WCU_REDLINES_FILE }
  $paths += (Join-Path $env:USERPROFILE ".dsh\wincu-redlines.json")
  foreach ($p in $paths) {
    if ($p -and (Test-Path $p)) {
      try { return (Get-Content $p -Raw | ConvertFrom-Json) } catch { return $null }
    }
  }
  return $null
}


# ============================================================================
# B: baselines on disk / observations / act() ladder / image-point clicks
# ============================================================================

function Get-WcuBaselinePath { return (Join-Path $env:TEMP "wcu-baselines.json") }

function Import-WcuBaselines {
  if ($null -ne $script:WcuBaselines) { return $script:WcuBaselines }
  $script:WcuBaselines = @{}
  $p = Get-WcuBaselinePath
  if (Test-Path $p) {
    try {
      $raw = Get-Content $p -Raw | ConvertFrom-Json
      foreach ($prop in $raw.PSObject.Properties) { $script:WcuBaselines[$prop.Name] = $prop.Value }
    } catch { $script:WcuBaselines = @{} }
  }
  return $script:WcuBaselines
}

function Save-WcuBaseline {
  param([string]$Key, [string]$Hash)
  $map = Import-WcuBaselines
  $map[$Key] = $Hash
  if ($map.Count -gt 200) {
    $keys = @($map.Keys) | Select-Object -First ($map.Count - 200)
    foreach ($k in $keys) { $map.Remove($k) }
  }
  try { ($map | ConvertTo-Json -Compress) | Set-Content -Path (Get-WcuBaselinePath) -Encoding UTF8 } catch { }
}

function Get-WcuBaseline {
  param([string]$Key)
  $map = Import-WcuBaselines
  if ($map.ContainsKey($Key)) { return $map[$Key] }
  return $null
}

# ---- observations: remember what a captured image looked like on screen ----
function Register-WcuObservation {
  param($ShotMeta, [int]$Width, [int]$Height, $CroppedTo)
  if ($null -eq $script:WcuObservations) { $script:WcuObservations = @{} }
  $script:WcuObsSeq = [int]$script:WcuObsSeq + 1
  $id = "obs" + $script:WcuObsSeq
  $script:WcuObservations[$id] = @{
    id = $id
    bounds = $ShotMeta.bounds
    imageScale = $(if ($null -ne $ShotMeta["imageScale"]) { [double]$ShotMeta["imageScale"] } else { 1.0 })
    origin = $(if ($null -ne $ShotMeta["origin"]) { $ShotMeta["origin"] } else { [ordered]@{ x = $ShotMeta.bounds.x; y = $ShotMeta.bounds.y } })
    width = $Width
    height = $Height
    croppedTo = $CroppedTo
    at = [DateTime]::UtcNow
  }
  if ($script:WcuObservations.Count -gt 12) {
    $oldest = $script:WcuObservations.GetEnumerator() | Sort-Object { $_.Value.at } | Select-Object -First 1
    if ($null -ne $oldest -and $oldest.Key -ne $id) { $script:WcuObservations.Remove($oldest.Key) }
  }
  return $script:WcuObservations[$id]
}

function Get-WcuObservation {
  param([string]$Id)
  if ($null -eq $script:WcuObservations) { $script:WcuObservations = @{} }
  if ([string]::IsNullOrEmpty($Id)) {
    if ($script:WcuObservations.Count -eq 0) { return $null }
    return ($script:WcuObservations.Values | Sort-Object { $_.at } | Select-Object -Last 1)
  }
  if ($script:WcuObservations.ContainsKey($Id)) { return $script:WcuObservations[$Id] }
  return $null
}

# Image pixel -> screen pixel for a previous observation (handles downscale + crop).
function Convert-WcuImagePointToScreen {
  param($Observation, [double]$ImageX, [double]$ImageY)
  if ($null -eq $Observation) { throw "Unknown or missing observation. Call observe first, then pass its observationId." }
  $scale = [double]$Observation.imageScale
  if ($scale -le 0) { $scale = 1.0 }
  $x = [double]$Observation.origin.x + ($ImageX / $scale)
  $y = [double]$Observation.origin.y + ($ImageY / $scale)
  return [ordered]@{
    screen = [ordered]@{ x = [int][Math]::Round($x); y = [int][Math]::Round($y) }
    image = [ordered]@{ x = [int]$ImageX; y = [int]$ImageY }
    imageScale = $scale
    origin = $Observation.origin
  }
}

function Invoke-WcuClickImagePoint {
  param($InputObject)
  $obs = Get-WcuObservation -Id ([string](Get-Prop $InputObject "observationId" ""))
  $ix = ConvertTo-WcuInt (Get-Prop $InputObject "imageX" -1)
  $iy = ConvertTo-WcuInt (Get-Prop $InputObject "imageY" -1)
  if ($ix -lt 0 -or $iy -lt 0) { throw "click_image_point requires imageX and imageY (pixels inside the observed image)." }
  $conv = Convert-WcuImagePointToScreen -Observation $obs -ImageX $ix -ImageY $iy
  $x = $conv.screen.x
  $y = $conv.screen.y
  $delivery = [string](Get-Prop $InputObject "delivery" "ladder")
  $identity = Get-WcuTargetIdentity -InputObject $InputObject
  $red = Test-WcuRedLine -Identity $identity
  if ($null -ne $red) { return [ordered]@{ ok = $false; action = "click_image_point"; refused = "red-line"; detail = $red; inputSent = $false } }
  $clickArgs = @{
    x = $x
    y = $y
    button = [string](Get-Prop $InputObject "button" "left")
    dispatch = $(if ($delivery -eq "foreground") { "foreground" } else { "background" })
  }
  if ($null -ne (Get-Prop $InputObject "windowTitle" $null)) { $clickArgs["windowTitle"] = Get-Prop $InputObject "windowTitle" $null }
  if ($null -ne (Get-Prop $InputObject "processId" $null)) { $clickArgs["processId"] = Get-Prop $InputObject "processId" $null }
  if ($null -ne (Get-Prop $InputObject "nativeWindowHandle" $null)) { $clickArgs["nativeWindowHandle"] = Get-Prop $InputObject "nativeWindowHandle" $null }
  if ($null -ne $obs) { $clickArgs["homing"] = "strict" }
  $res = Invoke-Action -Action "click" -InputObject ([pscustomobject]$clickArgs)
  $res["action"] = "click_image_point"
  $res["converted"] = $conv
  $res["observationId"] = $(if ($null -ne $obs) { $obs.id } else { $null })
  return $res
}

# ---- outcome check shared by act() ----
function Test-WcuOutcome {
  param($InputObject, $Expect, [int]$TimeoutMs = 2500, [string]$BeforeHash = $null)
  if ($null -ne $Expect -and @($Expect).Count -gt 0) {
    $verify = Invoke-WcuVerifyState -InputObject ([pscustomobject]@{
      windowTitle = Get-Prop $InputObject "windowTitle" $null
      processId = Get-Prop $InputObject "processId" $null
      nativeWindowHandle = Get-Prop $InputObject "nativeWindowHandle" $null
      predicates = @($Expect)
      timeoutMs = $TimeoutMs
      intervalMs = 300
    })
    return [ordered]@{ verified = [bool]$verify.passed; by = "predicates"; attempts = $verify.attempts; elapsedMs = $verify.elapsedMs; results = $verify.results }
  }
  $after = $null
  try { $after = Invoke-WcuCaptureHash -InputObject $InputObject } catch { }
  if ($null -eq $after -or [string]::IsNullOrEmpty($BeforeHash)) {
    return [ordered]@{ verified = $false; by = "pixels"; note = "no baseline or capture available; pass expect:[...] to verify a specific outcome" }
  }
  $changed = ($after.hash -ne $BeforeHash)
  return [ordered]@{ verified = $changed; by = "pixels"; beforeHash = $BeforeHash; afterHash = $after.hash; note = "verified means the target pixels changed; pass expect:[...] for a semantic check" }
}

# ---- act(): intent level action with a delivery ladder + verification ----
function Invoke-WcuAct {
  param($InputObject)
  $action = [string](Get-Prop $InputObject "action" "")
  if ([string]::IsNullOrEmpty($action)) { throw "act requires 'action' (click|double_click|type_text|keypress|scroll|set_value|invoke)." }
  $delivery = [string](Get-Prop $InputObject "delivery" "ladder")
  $expect = Get-Prop $InputObject "expect" @()
  $expectTimeoutMs = [int](Get-Prop $InputObject "expectTimeoutMs" 2500)
  $allowForeground = [bool](Get-Prop $InputObject "allowForeground" $false)

  $identity = Get-WcuTargetIdentity -InputObject $InputObject
  $red = Test-WcuRedLine -Identity $identity
  if ($null -ne $red) {
    return [ordered]@{ ok = $false; action = "act"; refused = "red-line"; detail = $red; inputSent = $false; target = $identity }
  }

  $before = $null
  try { $before = Invoke-WcuCaptureHash -InputObject $InputObject } catch { }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $steps = New-Object System.Collections.Generic.List[object]
  $verified = $false
  $verifiedBy = $null

  $rungs = New-Object System.Collections.Generic.List[string]
  if ($delivery -eq "ladder" -or $delivery -eq "semantic") { [void]$rungs.Add("semantic") }
  if ($delivery -eq "ladder" -or $delivery -eq "background") { [void]$rungs.Add("background") }
  if ($delivery -eq "foreground") { [void]$rungs.Add("foreground") }
  elseif ($delivery -eq "ladder" -and $allowForeground) { [void]$rungs.Add("foreground") }

  foreach ($rung in $rungs) {
    $step = [ordered]@{ rung = $rung; delivered = $false }
    try {
      switch ($rung) {
        "semantic" {
          $elementId = Get-Prop $InputObject "elementId" $null
          if ($null -eq $elementId) { $step["skipped"] = "no elementId" ; break }
          $el = Resolve-Element $elementId $InputObject
          if ($action -eq "set_value") {
            $ok = Set-ElementValue -Element $el -Value ([string](Get-Prop $InputObject "text" ""))
            $step["method"] = "uia:set_value"; $step["delivered"] = [bool]$ok
          } elseif ($action -eq "click" -or $action -eq "double_click" -or $action -eq "invoke") {
            $m = Invoke-ElementPattern $el
            $step["method"] = "uia:" + [string]$m; $step["delivered"] = ($null -ne $m)
          } else {
            $step["skipped"] = "no semantic rung for action '" + $action + "'"
          }
        }
        "background" {
          $hwnd = 0
          $elementId = Get-Prop $InputObject "elementId" $null
          if ($null -ne $elementId) { $hwnd = ConvertTo-WcuInt (Invoke-Safe { (Resolve-Element $elementId $InputObject).Current.NativeWindowHandle } 0) }
          if ($hwnd -le 0) { $hwnd = Get-WcuTargetHwnd -InputObject $InputObject }
          if ($hwnd -le 0) { $step["skipped"] = "no window handle for background delivery"; break }
          switch ($action) {
            "click" {
              $pt = Get-PointFromArgs $InputObject
              $ok = Post-BackgroundClick -Hwnd ([long]$hwnd) -X $pt.x -Y $pt.y -Button ([string](Get-Prop $InputObject "button" "left")) -Count 1
              $step["method"] = "postmessage:click"; $step["delivered"] = [bool]$ok
            }
            "double_click" {
              $pt = Get-PointFromArgs $InputObject
              $ok = Post-BackgroundClick -Hwnd ([long]$hwnd) -X $pt.x -Y $pt.y -Button ([string](Get-Prop $InputObject "button" "left")) -Count 2
              $step["method"] = "postmessage:doubleclick"; $step["delivered"] = [bool]$ok
            }
            "type_text" {
              $text = [string](Get-Prop $InputObject "text" "")
              $ok = Post-BackgroundText -Hwnd ([long]$hwnd) -Text $text
              $step["method"] = "postmessage:text"; $step["delivered"] = [bool]$ok
            }
            default { $step["skipped"] = "background rung not defined for action '" + $action + "'" }
          }
        }
        "foreground" {
          $fg = [ordered]@{
            windowTitle = Get-Prop $InputObject "windowTitle" $null
            processId = Get-Prop $InputObject "processId" $null
            nativeWindowHandle = Get-Prop $InputObject "nativeWindowHandle" $null
            elementId = Get-Prop $InputObject "elementId" $null
            x = Get-Prop $InputObject "x" $null
            y = Get-Prop $InputObject "y" $null
            space = Get-Prop $InputObject "space" "screen"
            homing = Get-Prop $InputObject "homing" "strict"
            button = Get-Prop $InputObject "button" "left"
            text = Get-Prop $InputObject "text" $null
            keys = Get-Prop $InputObject "keys" $null
            deltaX = Get-Prop $InputObject "deltaX" 0
            deltaY = Get-Prop $InputObject "deltaY" 0
            dispatch = "foreground"
          }
          $inner = Invoke-Action -Action $action -InputObject ([pscustomobject]$fg)
          $step["method"] = "sendinput:" + $action
          $step["delivered"] = [bool]$inner.ok
          $step["detail"] = $inner
        }
      }
    } catch {
      $step["error"] = $_.Exception.Message
    }
    $step["elapsedMs"] = [int]$sw.ElapsedMilliseconds
    if ($step["delivered"]) {
      $outcome = Test-WcuOutcome -InputObject $InputObject -Expect $expect -TimeoutMs $expectTimeoutMs -BeforeHash $(if ($null -ne $before) { $before.hash } else { $null })
      $step["outcome"] = $outcome
      if ($outcome.verified) { $verified = $true; $verifiedBy = $outcome.by; $steps.Add($step); break }
    }
    $steps.Add($step)
  }

  $result = [ordered]@{
    ok = $verified
    action = "act"
    intent = $action
    delivery = $delivery
    outcome = $(if ($verified) { "verified" } else { "unverified" })
    verifiedBy = $verifiedBy
    rungsTried = @($rungs.ToArray())
    steps = @($steps.ToArray())
    elapsedMs = [int]$sw.ElapsedMilliseconds
    target = $identity
  }
  if (-not $verified) {
    $result["hint"] = "None of the tried rungs produced a verified outcome. Re-observe before retrying; pass expect:[...] for a semantic check, or allowForeground:true to add the real-input rung. A refusal never authorizes a foreground retry by itself."
  }
  return $result
}




# ============================================================================
# D: transient UI, tree queries, drag sessions, app index, secondary actions
# ============================================================================

function Get-WcuWindowOwner {
  param([int]$Handle)
  Initialize-WcuExtNative
  if ($Handle -le 0) { return 0 }
  return (ConvertTo-WcuInt ([WcuExt.Native]::GetWindow([IntPtr]$Handle, 4)))
}

function Get-WcuWindowBounds {
  param([int]$Handle)
  Initialize-WcuExtNative
  $r = New-Object WcuExt.Native+RECT
  if (-not [WcuExt.Native]::GetWindowRect([IntPtr]$Handle, [ref]$r)) { return $null }
  return [ordered]@{ x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
}

# Transient UI the target owns: its last active popup plus every visible
# top-level window whose GW_OWNER is the target. Menus and modal dialogs often
# live outside the window rectangle, so a plain window capture misses them.
function Get-WcuTransientWindows {
  param($InputObject, [int]$Max = 3)
  Initialize-WcuExtNative
  $target = Get-WcuTargetHwnd -InputObject $InputObject
  if ($target -le 0) { return @() }
  $found = New-Object System.Collections.Generic.List[object]
  $seen = @{}
  $popup = ConvertTo-WcuInt ([WcuExt.Native]::GetLastActivePopup([IntPtr]$target))
  if ($popup -gt 0 -and $popup -ne $target -and [WcuExt.Native]::IsWindowVisible([IntPtr]$popup)) {
    $seen[[string]$popup] = $true
    $info = Get-WcuHwndInfo -Handle $popup
    $info["role"] = "active-popup"
    $info["boundingBox"] = (Get-WcuWindowBounds -Handle $popup)
    $found.Add($info)
  }
  foreach ($h in [WindowsComputerUseNative]::TopLevelWindows()) {
    if ($found.Count -ge $Max) { break }
    $hv = ConvertTo-WcuInt $h.ToInt64()
    if ($hv -le 0 -or $hv -eq $target) { continue }
    if ($seen.ContainsKey([string]$hv)) { continue }
    if ((Get-WcuWindowOwner -Handle $hv) -ne $target) { continue }
    if (-not [WcuExt.Native]::IsWindowVisible([IntPtr]$hv)) { continue }
    $seen[[string]$hv] = $true
    $info = Get-WcuHwndInfo -Handle $hv
    $info["role"] = "owned-window"
    $info["boundingBox"] = (Get-WcuWindowBounds -Handle $hv)
    $found.Add($info)
  }
  return $found.ToArray()
}

function Invoke-WcuTransientWindows {
  param($InputObject)
  $list = Get-WcuTransientWindows -InputObject $InputObject -Max ([int](Get-Prop $InputObject "max" 5))
  return [ordered]@{ ok = $true; action = "transient_windows"; count = @($list).Count; windows = @($list) }
}

# ---- tree query: keep matching nodes (plus their ancestors' context) ----
function Test-WcuNodeMatch {
  param($Node, [string]$Needle)
  if ($null -eq $Node) { return $false }
  foreach ($field in @("name", "automationId", "className", "controlType", "value", "helpText")) {
    $v = $Node[$field]
    if ($null -ne $v -and ([string]$v).ToLowerInvariant().Contains($Needle)) { return $true }
  }
  return $false
}

function Select-WcuTreeQuery {
  param($Nodes, [string]$Query)
  if ([string]::IsNullOrEmpty($Query)) { return $Nodes }
  $q = $Query.ToLowerInvariant()
  $kept = New-Object System.Collections.Generic.List[object]
  $stack = New-Object System.Collections.Generic.List[object]
  foreach ($n in @($Nodes)) { $stack.Add(@{ node = $n; depth = 0 }) }
  while ($stack.Count -gt 0) {
    $entry = $stack[$stack.Count - 1]
    $stack.RemoveAt($stack.Count - 1)
    $node = $entry.node
    $matches = Test-WcuNodeMatch -Node $node -Needle $q
    $children = @()
    if ($null -ne $node["children"]) { $children = @($node["children"]) }
    $childHits = $false
    foreach ($c in $children) {
      if (Test-WcuNodeMatch -Node $c -Needle $q) { $childHits = $true; continue }
      if ($null -ne $c["children"] -and @($c["children"]).Count -gt 0) { $childHits = $true }
    }
    if ($matches -or $childHits) {
      $kept.Add([ordered]@{
        depth = $entry.depth
        id = $node["id"]; name = $node["name"]; automationId = $node["automationId"]
        className = $node["className"]; controlType = $node["controlType"]
        boundingBox = $node["boundingBox"]; isEnabled = $node["isEnabled"]; isOffscreen = $node["isOffscreen"]
        value = $node["value"]
        childCount = $(if ($null -ne $node["children"]) { @($node["children"]).Count } else { 0 })
        matched = $matches
      })
    }
    foreach ($c in $children) { $stack.Add(@{ node = $c; depth = ($entry.depth + 1) }) }
  }
  return $kept.ToArray()
}

function Invoke-WcuTreeQuery {
  param($InputObject)
  $query = [string](Get-Prop $InputObject "query" "")
  $tree = Get-Prop $InputObject "tree" $null
  if ($null -eq $tree) { throw "tree_query requires 'tree' (the nodes array from snapshot/accessibility_tree)." }
  $flat = Select-WcuTreeQuery -Nodes $tree -Query $query
  return [ordered]@{ ok = $true; action = "tree_query"; query = $query; matchCount = @($flat).Count; nodes = @($flat) }
}

# ---- point ownership: which window would really receive this click? ----
function Invoke-WcuPointOwner {
  param($InputObject)
  $x = ConvertTo-WcuInt (Get-Prop $InputObject "x" -1)
  $y = ConvertTo-WcuInt (Get-Prop $InputObject "y" -1)
  if ($x -lt 0 -or $y -lt 0) { throw "point_owner requires screen x and y." }
  $hwnd = Get-WcuWindowAtPoint -X $x -Y $y
  $info = $null
  if ($hwnd -gt 0) { $info = Get-WcuHwndInfo -Handle $hwnd }
  $targetHwnd = ConvertTo-WcuInt (Get-Prop $InputObject "targetHwnd" 0)
  $matches = $null
  $descendant = $false
  if ($targetHwnd -gt 0 -and $hwnd -gt 0) {
    $matches = ($hwnd -eq $targetHwnd)
    if (-not $matches -and (Test-WcuWindowBelongsTo -Candidate $hwnd -Target $targetHwnd)) { $matches = $true; $descendant = $true }
    if (-not $matches -and (Get-WcuWindowOwner -Handle $hwnd) -eq $targetHwnd) { $matches = $true; $descendant = $true }
  }
  return [ordered]@{ ok = $true; action = "point_owner"; point = [ordered]@{ x = $x; y = $y }; window = $info; targetHwnd = $targetHwnd; matchesTarget = $matches; hitIsChildOfTarget = $descendant }
}

# ---- secondary (accessibility action) surface ----
function Get-WcuSecondaryActions {
  param($Element)
  $list = New-Object System.Collections.Generic.List[string]
  if ($null -eq $Element) { return @() }
  $p = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { [void]$list.Add("Invoke") }
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { [void]$list.Add("Toggle") }
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
    [void]$list.Add("Expand"); [void]$list.Add("Collapse")
  }
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
    [void]$list.Add("Select"); [void]$list.Add("AddToSelection"); [void]$list.Add("RemoveFromSelection")
  }
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$p)) {
    $vertical = $true
    $horizontal = $false
    try {
      $cur = $p.Current
      $vertical = [bool]$cur.VerticallyScrollable
      $horizontal = [bool]$cur.HorizontallyScrollable
    } catch { }
    if ($vertical) { [void]$list.Add("Scroll Up"); [void]$list.Add("Scroll Down") }
    if ($horizontal) { [void]$list.Add("Scroll Left"); [void]$list.Add("Scroll Right") }
  }
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$p)) { [void]$list.Add("Raise") }
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { [void]$list.Add("SetValue") }
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$p)) { [void]$list.Add("SetRangeValue") }
  if ((Test-WcuLegacyPatternAvailable) -and $Element.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$p)) { [void]$list.Add("Default") }
  [void]$list.Add("SetFocus")
  return @($list.ToArray())
}

function Invoke-WcuSecondaryAction {
  param($InputObject)
  $elementId = [string](Get-Prop $InputObject "elementId" "")
  $action = [string](Get-Prop $InputObject "action" "")
  if ([string]::IsNullOrEmpty($elementId)) { throw "secondary_action requires elementId (from snapshot/accessibility_tree)." }
  if ([string]::IsNullOrEmpty($action)) { throw "secondary_action requires action; see element_info.secondaryActions for what the element supports." }
  $el = Resolve-Element $elementId $InputObject
  $available = Get-WcuSecondaryActions -Element $el
  $name = $action.ToLowerInvariant()
  $p = $null
  $method = $null
  $value = Get-Prop $InputObject "value" $null
  switch ($name) {
    "invoke" { if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); $method = "InvokePattern.Invoke" } }
    "toggle" { if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); $method = "TogglePattern.Toggle" } }
    "expand" { if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); $method = "ExpandCollapsePattern.Expand" } }
    "collapse" { if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Collapse(); $method = "ExpandCollapsePattern.Collapse" } }
    "select" { if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); $method = "SelectionItemPattern.Select" } }
    "addtoselection" { if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.AddToSelection(); $method = "SelectionItemPattern.AddToSelection" } }
    "removefromselection" { if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.RemoveFromSelection(); $method = "SelectionItemPattern.RemoveFromSelection" } }
    "scroll up" { if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$p)) { $p.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::LargeDecrement); $method = "ScrollPattern.Scroll(up)" } }
    "scroll down" { if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$p)) { $p.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::LargeIncrement); $method = "ScrollPattern.Scroll(down)" } }
    "scroll left" { if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$p)) { $p.Scroll([System.Windows.Automation.ScrollAmount]::LargeDecrement, [System.Windows.Automation.ScrollAmount]::NoAmount); $method = "ScrollPattern.Scroll(left)" } }
    "scroll right" { if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$p)) { $p.Scroll([System.Windows.Automation.ScrollAmount]::LargeIncrement, [System.Windows.Automation.ScrollAmount]::NoAmount); $method = "ScrollPattern.Scroll(right)" } }
    "raise" {
      if ($el.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$p)) { $p.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal); $method = "WindowPattern.SetWindowVisualState(Normal)" }
      else { $el.SetFocus(); $method = "SetFocus" }
    }
    "setvalue" { if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $p.SetValue([string]$value); $method = "ValuePattern.SetValue" } }
    "setrangevalue" { if ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$p)) { $p.SetValue([double](Get-Prop $InputObject "value" 0)); $method = "RangeValuePattern.SetValue" } }
    "default" { if ((Test-WcuLegacyPatternAvailable) -and $el.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$p)) { $p.DoDefaultAction(); $method = "LegacyIAccessiblePattern.DoDefaultAction" } }
    "setfocus" { $el.SetFocus(); $method = "AutomationElement.SetFocus" }
    default { }
  }
  if ($null -eq $method) {
    return [ordered]@{
      ok = $false
      action = "secondary_action"
      requested = $action
      elementId = $elementId
      error = "The element does not support '" + $action + "'."
      availableActions = @($available)
    }
  }
  return [ordered]@{
    ok = $true
    action = "secondary_action"
    performed = $action
    method = $method
    elementId = $elementId
    availableActions = @($available)
  }
}

# ---- drag sessions (press, move in steps, observe between, release) ----
function Close-WcuDragSession {
  param([switch]$Release)
  $s = $script:WcuDragSession
  if ($null -eq $s) { return $false }
  if ($Release) {
    try { [void][WindowsComputerUseNative]::SendMouseEvent(0, 0, [uint32]$s.upFlag, 0) } catch { }
  }
  $script:WcuDragSession = $null
  return $true
}

function Invoke-WcuDragStart {
  param($InputObject)
  [void](Test-Failsafe)
  Initialize-WcuExtNative
  if ($null -ne $script:WcuDragSession) { Close-WcuDragSession -Release | Out-Null }
  $hasExplicitTarget = ($null -ne (Get-Prop $InputObject "windowTitle" $null)) -or ($null -ne (Get-Prop $InputObject "processId" $null)) -or ($null -ne (Get-Prop $InputObject "nativeWindowHandle" $null))
  $identity = Get-WcuTargetIdentity -InputObject $InputObject
  if ($hasExplicitTarget) {
    $red = Test-WcuRedLine -Identity $identity -Action "drag_start"
    if ($null -ne $red) {
      return [ordered]@{ ok = $false; action = "drag_start"; refused = "red-line"; detail = $red; target = $identity; inputSent = $false }
    }
  }
  $button = [string](Get-Prop $InputObject "button" "left")
  $flags = Get-ButtonFlags $button
  $elementId = Get-Prop $inputObject "elementId" $null
  if ($null -ne $elementId) {
    $el = Resolve-Element $elementId $InputObject
    $rect = Convert-Rect (Invoke-Safe { $el.Current.BoundingRectangle } $null)
    if ($null -eq $rect) { throw "Element '$elementId' has no clickable bounding box." }
    $px = [int]$rect.centerX
    $py = [int]$rect.centerY
  } else {
    $info = Get-PointFromArgs $InputObject
    $px = [int]$info.x
    $py = [int]$info.y
  }
  [void][WcuExt.Native]::SetCursorPos($px, $py)
  Start-Sleep -Milliseconds 60
  [void][WindowsComputerUseNative]::SendMouseEvent(0, 0, [uint32]$flags[0], 0)
  $script:WcuDragSession = [ordered]@{
    button = $button
    upFlag = $flags[1]
    downFlag = $flags[0]
    startX = $px
    startY = $py
    x = $px
    y = $py
    steps = 0
    startedAt = [DateTime]::UtcNow
    target = $identity
  }
  return [ordered]@{
    ok = $true
    action = "drag_start"
    x = $px
    y = $py
    button = $button
    held = $true
    target = $identity
    note = "Mouse button is held down. Use drag_step to move (and observe in between if you need feedback), then drag_end to release."
  }
}

function Invoke-WcuDragStep {
  param($InputObject)
  Initialize-WcuExtNative
  $s = $script:WcuDragSession
  if ($null -eq $s) { throw "drag_step without an open drag session; call drag_start first." }
  $ageSec = ([DateTime]::UtcNow - $s.startedAt).TotalSeconds
  $timeoutSec = [int](Get-Prop $InputObject "timeoutSeconds" 30)
  if ($ageSec -gt $timeoutSec) {
    Close-WcuDragSession -Release | Out-Null
    throw ("drag session expired after " + [int]$ageSec + "s (timeout " + $timeoutSec + "s); the button was released. Call drag_start again.")
  }
  $info = Get-PointFromArgs $InputObject
  $tx = [int]$info.x
  $ty = [int]$info.y
  $durationMs = [int](Get-Prop $InputObject "durationMs" 200)
  $micro = [Math]::Max(1, [Math]::Min(40, [int]($durationMs / 10)))
  $steps = [Math]::Max(1, [int]($durationMs / $micro))
  $sx = [int]$s.x
  $sy = [int]$s.y
  for ($i = 1; $i -le $steps; $i++) {
    $nx = [int]($sx + (($tx - $sx) * $i / $steps))
    $ny = [int]($sy + (($ty - $sy) * $i / $steps))
    [void][WcuExt.Native]::SetCursorPos($nx, $ny)
    Start-Sleep -Milliseconds $micro
  }
  $s.x = $tx
  $s.y = $ty
  $s.steps = [int]$s.steps + 1
  $script:WcuDragSession = $s
  return [ordered]@{ ok = $true; action = "drag_step"; x = $tx; y = $ty; from = [ordered]@{ x = $sx; y = $sy }; steps = $s.steps; held = $true }
}

function Invoke-WcuDragEnd {
  param($InputObject)
  $s = $script:WcuDragSession
  if ($null -eq $s) { throw "drag_end without an open drag session; call drag_start first." }
  Start-Sleep -Milliseconds ([Math]::Max(0, [int](Get-Prop $InputObject "settleMs" 120)))
  $expect = Get-Prop $InputObject "expect" @()
  $targetHwnd = 0
  if ($null -ne $s.target -and $null -ne $s.target.hwnd) { $targetHwnd = ConvertTo-WcuInt $s.target.hwnd }
  [void](Close-WcuDragSession -Release)
  $dragOut = [ordered]@{
    ok = $true
    action = "drag_end"
    x = $s.x
    y = $s.y
    startX = $s.startX
    startY = $s.startY
    steps = $s.steps
    button = $s.button
    held = $false
    durationSeconds = [Math]::Round(([DateTime]::UtcNow - $s.startedAt).TotalSeconds, 2)
  }
  # Optional verification: a drag that "finished" is not proof it landed.
  if ($null -ne $expect -and @($expect).Count -gt 0) {
    $verifyArgs = [pscustomobject]@{ nativeWindowHandle = $targetHwnd }
    $outcome = Test-WcuOutcome -InputObject $verifyArgs -Expect $expect -TimeoutMs ([int](Get-Prop $InputObject "expectTimeoutMs" 2500))
    $dragOut["outcome"] = $outcome
    $dragOut["ok"] = [bool]$outcome.verified
  }
  return $dragOut
}

# ---- installed application index ----
function Get-WcuRecentAppUsage {
  $map = @{}
  $recent = Join-Path $env:APPDATA "Microsoft\Windows\Recent"
  if (Test-Path $recent) {
    try {
      Get-ChildItem $recent -Filter *.lnk -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 200 |
        ForEach-Object {
          $base = $_.BaseName
          $key = ($base -replace '\s*\(.*$', '').Trim().ToLowerInvariant()
          if ($key -and -not $map.ContainsKey($key)) { $map[$key] = $_.LastWriteTime.ToString("s") }
        }
    } catch { }
  }
  return $map
}
function Get-WcuAppIndex {
  param([int]$Max = 400)
  $ttlSec = 120
  if ($null -ne $script:WcuAppIndexCache) {
    $age = ([DateTime]::UtcNow - $script:WcuAppIndexCache.at).TotalSeconds
    if ($age -lt $ttlSec) { return $script:WcuAppIndexCache.apps }
  }
  $built = Get-WcuAppIndexUncached -Max $Max
  $script:WcuAppIndexCache = @{ at = [DateTime]::UtcNow; apps = $built }
  return $built
}

function Get-WcuAppIndexUncached {
  param([int]$Max = 400)
  $apps = New-Object System.Collections.Generic.List[object]
  $seen = @{}
  $recent = Get-WcuRecentAppUsage
  $shell = $null
  try { $shell = New-Object -ComObject WScript.Shell } catch { $shell = $null }
  if ($null -ne $shell) {
    $dirs = @(
      (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs"),
      (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs")
    )
    foreach ($dir in $dirs) {
      if (-not (Test-Path $dir)) { continue }
      foreach ($lnk in (Get-ChildItem $dir -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Select-Object -First $Max)) {
        $target = $null
        try { $target = $shell.CreateShortcut($lnk.FullName).TargetPath } catch { $target = $null }
        if ([string]::IsNullOrEmpty($target)) { continue }
        if ($target -notmatch '\.exe$') { continue }
        $key = $target.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $name = [System.IO.Path]::GetFileNameWithoutExtension($lnk.Name)
        $apps.Add([ordered]@{
          displayName = $name
          id = $target
          kind = "exe"
          shortcut = $lnk.FullName
          lastUsed = $(if ($recent.ContainsKey($name.ToLowerInvariant())) { $recent[$name.ToLowerInvariant()] } else { $null })
        })
      }
    }
  }
  if (Get-Command Get-StartApps -ErrorAction SilentlyContinue) {
    try {
      foreach ($a in (Get-StartApps | Select-Object -First $Max)) {
        $id = [string]$a.AppID
        if ([string]::IsNullOrEmpty($id)) { continue }
        $key = ("aumid:" + $id).ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $apps.Add([ordered]@{
          displayName = [string]$a.Name
          id = $id
          kind = $(if ($id -match '!') { "aumid" } else { "appid" })
          shortcut = $null
          lastUsed = $null
        })
      }
    } catch { }
  }
  return $apps.ToArray()
}

function Resolve-WcuAppId {
  param([string]$Name, [int]$Max = 5)
  if ([string]::IsNullOrEmpty($Name)) { return $null }
  $needle = $Name.ToLowerInvariant().Trim()
  $apps = @(Get-WcuAppIndex)
  $exact = @($apps | Where-Object { ([string]$_.displayName).ToLowerInvariant() -eq $needle })
  if ($exact.Count -gt 0) { return [ordered]@{ match = $exact[0]; candidates = @($exact | Select-Object -First $Max); exact = $true } }
  $partial = @($apps | Where-Object { ([string]$_.displayName).ToLowerInvariant().Contains($needle) -or ([string]$_.id).ToLowerInvariant().Contains($needle) })
  $partial = @($partial | Sort-Object -Property @{ Expression = { $_.lastUsed }; Descending = $true })
  return [ordered]@{ match = $(if ($partial.Count -gt 0) { $partial[0] } else { $null }); candidates = @($partial | Select-Object -First $Max); exact = $false }
}

function Invoke-WcuListApps {
  param($InputObject)
  $filter = [string](Get-Prop $InputObject "query" "")
  $apps = @(Get-WcuAppIndex)
  if (-not [string]::IsNullOrEmpty($filter)) {
    $f = $filter.ToLowerInvariant()
    $apps = @($apps | Where-Object { ([string]$_.displayName).ToLowerInvariant().Contains($f) })
  }
  $running = @{}
  try {
    foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
      if ($p.MainWindowHandle -eq 0) { continue }
      try { $running[([string]$p.MainModule.FileName).ToLowerInvariant()] = $p.Id } catch { }
    }
  } catch { }
  foreach ($a in $apps) {
    $key = ([string]$a.id).ToLowerInvariant()
    if ($a.kind -eq "exe" -and $running.ContainsKey($key)) {
      $a["isRunning"] = $true
      $a["processId"] = $running[$key]
    } else {
      $a["isRunning"] = $false
    }
  }
  $ordered = @($apps | Sort-Object -Property @{ Expression = { $_.isRunning }; Descending = $true }, @{ Expression = { $_.lastUsed }; Descending = $true }, @{ Expression = { $_.displayName }; Descending = $false })
  $limit = [int](Get-Prop $InputObject "max" 60)
  return [ordered]@{ ok = $true; action = "list_apps"; count = $ordered.Count; apps = @($ordered | Select-Object -First $limit) }
}



# ---- element action surface + app resolution (read-only helpers) ----
function Invoke-WcuElementActions {
  param($InputObject)
  $elementId = [string](Get-Prop $InputObject "elementId" "")
  if ([string]::IsNullOrEmpty($elementId)) { throw "element_actions requires elementId." }
  $el = Resolve-Element $elementId $InputObject
  $actions = Get-WcuSecondaryActions -Element $el
  return [ordered]@{ ok = $true; action = "element_actions"; elementId = $elementId; availableActions = @($actions); count = @($actions).Count }
}

function Invoke-WcuResolveApp {
  param($InputObject)
  $name = [string](Get-Prop $InputObject "name" "")
  if ([string]::IsNullOrEmpty($name)) { throw "resolve_app requires name (e.g. 'Notepad', 'Paint', 'Chrome')." }
  $r = Resolve-WcuAppId -Name $name -Max ([int](Get-Prop $InputObject "max" 5))
  if ($null -eq $r) { return [ordered]@{ ok = $false; action = "resolve_app"; name = $name; error = "no installed app matched" } }
  return [ordered]@{
    ok = ($null -ne $r.match)
    action = "resolve_app"
    name = $name
    exact = $r.exact
    match = $r.match
    candidates = @($r.candidates)
  }
}

function Test-WcuLegacyPatternAvailable {
  # LegacyIAccessiblePattern is missing from some UIAutomation builds; probing it
  # blindly threw 'type not found' into otherwise healthy results.
  return ($null -ne ("System.Windows.Automation.LegacyIAccessiblePattern" -as [type]))
}
function Clip-WcuText {
  param([string]$Text, [int]$MaxChars = 4000)
  if ($null -eq $Text) { return $null }
  if ($Text.Length -le $MaxChars) { return $Text }
  return $Text.Substring(0, $MaxChars) + "...(truncated)"
}

# Read a control's text. UI toolkits expose it through different automation
# patterns, so try them in order and report which one answered.
function Get-WcuElementText {
  param($Element, [int]$MaxChars = 4000)
  if ($null -eq $Element) { return $null }
  $p = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) } $false) {
    $v = Invoke-Safe { $p.Current.Value } $null
    if ($null -ne $v) { return [ordered]@{ text = (Clip-WcuText ([string]$v) $MaxChars); source = "ValuePattern" } }
  }
  $p = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$p) } $false) {
    $v = Invoke-Safe { $p.DocumentRange.GetText(-1) } $null
    if (-not [string]::IsNullOrEmpty([string]$v)) { return [ordered]@{ text = (Clip-WcuText ([string]$v) $MaxChars); source = "TextPattern" } }
  }
  $p = $null
  if ((Test-WcuLegacyPatternAvailable) -and (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$p) } $false)) {
    $v = Invoke-Safe { $p.Current.Value } $null
    if (-not [string]::IsNullOrEmpty([string]$v)) { return [ordered]@{ text = (Clip-WcuText ([string]$v) $MaxChars); source = "LegacyIAccessible" } }
  }
  try {
    $hwnd = ConvertTo-WcuInt (Invoke-Safe { $Element.Current.NativeWindowHandle } 0)
    if ($hwnd -gt 0) {
      Initialize-WcuExtNative
      $sb = New-Object System.Text.StringBuilder 8192
      [void][WcuExt.Native]::GetWindowTextW([IntPtr]$hwnd, $sb, 8192)
      $v = $sb.ToString()
      if (-not [string]::IsNullOrEmpty($v)) { return [ordered]@{ text = (Clip-WcuText $v $MaxChars); source = "Win32.GetWindowText" } }
    }
  } catch { }
  return $null
}

function Invoke-WcuElementText {
  param($InputObject)
  $elementId = [string](Get-Prop $InputObject "elementId" "")
  if ([string]::IsNullOrEmpty($elementId)) { throw "element_text requires elementId." }
  $el = Resolve-Element $elementId $InputObject
  $hit = Get-WcuElementText -Element $el -MaxChars ([int](Get-Prop $InputObject "maxChars" 4000))
  if ($null -eq $hit) {
    return [ordered]@{ ok = $false; action = "element_text"; elementId = $elementId; text = $null; note = "No text/value exposed (tried ValuePattern, TextPattern, LegacyIAccessible, GetWindowText)." }
  }
  return [ordered]@{ ok = $true; action = "element_text"; elementId = $elementId; text = $hit.text; source = $hit.source; length = $hit.text.Length }
}

# Is `candidate` the target window or one of its descendants? WindowFromPoint
# returns the deepest child, so equality alone raises false 'wrong window' alarms.
function Test-WcuWindowBelongsTo {
  param([int]$Candidate, [int]$Target)
  if ($Candidate -le 0 -or $Target -le 0) { return $false }
  if ($Candidate -eq $Target) { return $true }
  Initialize-WcuExtNative
  $cur = $Candidate
  for ($i = 0; $i -lt 12; $i++) {
    $parent = ConvertTo-WcuInt (Invoke-Safe { [WcuExt.Native]::GetParent([IntPtr]$cur) } ([IntPtr]::Zero))
    if ($parent -le 0) { return $false }
    if ($parent -eq $Target) { return $true }
    $cur = $parent
  }
  return $false
}
# ---------------------------------------------------------------- dispatch
function Invoke-ExtAction {
  param([string]$Action, $InputObject = $null)
  switch ($Action) {
    "capabilities" { return (Get-WcuCapabilities -InputObject $InputObject) }
    "clipboard_read" {
      $includeText = [bool](Get-Prop $InputObject "includeText" $true)
      $includeImage = [bool](Get-Prop $InputObject "includeImage" $false)
      return (Get-WcuClipboard -IncludeText $includeText -IncludeImage $includeImage)
    }
    "clipboard_write" {
      $text = Get-Prop $InputObject "text" $null
      if ($null -eq $text) { throw "clipboard_write requires 'text'." }
      return (Set-WcuClipboardText -Text ([string]$text))
    }
    "launch_app" { return (Start-WcuApp -InputObject $InputObject) }
    "kill_app" { return (Stop-WcuApp -InputObject $InputObject) }
    "element_text" { return (Invoke-WcuElementText -InputObject $InputObject) }
    "element_actions" { return (Invoke-WcuElementActions -InputObject $InputObject) }
    "resolve_app" { return (Invoke-WcuResolveApp -InputObject $InputObject) }
    "transient_windows" { return (Invoke-WcuTransientWindows -InputObject $InputObject) }
    "tree_query" { return (Invoke-WcuTreeQuery -InputObject $InputObject) }
    "point_owner" { return (Invoke-WcuPointOwner -InputObject $InputObject) }
    "secondary_action" { return (Invoke-WcuSecondaryAction -InputObject $InputObject) }
    "drag_start" { return (Invoke-WcuDragStart -InputObject $InputObject) }
    "drag_step" { return (Invoke-WcuDragStep -InputObject $InputObject) }
    "drag_end" { return (Invoke-WcuDragEnd -InputObject $InputObject) }
    "list_apps" { return (Invoke-WcuListApps -InputObject $InputObject) }
    "act" { return (Invoke-WcuAct -InputObject $InputObject) }
    "click_image_point" { return (Invoke-WcuClickImagePoint -InputObject $InputObject) }
    "baselines" {
      $map = Import-WcuBaselines
      return [ordered]@{ ok = $true; action = "baselines"; count = $map.Count; path = (Get-WcuBaselinePath); keys = @($map.Keys | Select-Object -First 20) }
    }
    "observations" {
      $obs = Get-WcuObservation -Id ([string](Get-Prop $InputObject "observationId" ""))
      return [ordered]@{ ok = $true; action = "observations"; count = $(if ($null -ne $script:WcuObservations) { $script:WcuObservations.Count } else { 0 }); latest = $obs }
    }
    "describe" { return (Invoke-WcuDescribe -InputObject $InputObject) }
    "agent_cursor" { return (Invoke-WcuAgentCursor -InputObject $InputObject) }
    "virtual_click" { return (Invoke-WcuVirtualClick -InputObject $InputObject) }
    "virtual_move" { return (Invoke-WcuVirtualMove -InputObject $InputObject) }
    "observe" { return (Invoke-WcuObserve -InputObject $InputObject) }
    "capture_hash" { return (Invoke-WcuCaptureHash -InputObject $InputObject) }
    "verify_state" { return (Invoke-WcuVerifyState -InputObject $InputObject) }
    "target_identity" {
      $identity = Get-WcuTargetIdentity -InputObject $InputObject
      $wrapped = [ordered]@{ ok = $true; action = "target_identity"; target = $identity }
      $wantTitle = [string](Get-Prop $InputObject "windowTitle" "")
      if (-not [string]::IsNullOrWhiteSpace($wantTitle)) {
        # A loose substring can match several windows; say so instead of silently
        # picking one.
        $matches = @()
        foreach ($w in (Get-NativeWindowList -IncludeInvisible $false -MaxWindows 500)) {
          if (([string]$w.name).IndexOf($wantTitle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $matches += [ordered]@{ hwnd = $w.nativeWindowHandle; title = $w.name; processName = (Get-WcuProcessName -ProcessId (ConvertTo-WcuInt $w.processId)); exact = (([string]$w.name) -eq $wantTitle) }
          }
        }
        if ($matches.Count -gt 1) {
          $wrapped["ambiguousTitle"] = $true
          $wrapped["matchCandidates"] = @($matches | Select-Object -First 5)
          $wrapped["hint"] = "More than one window title contains that text; pass an exact title or a window handle to be unambiguous."
        }
      }
      if ([bool](Get-Prop $InputObject "includeForeground" $false)) {
        $wrapped["foreground"] = Get-WcuForegroundIdentity
        $wrapped["preflight"] = "engine"
      }
      return $wrapped
    }
    default { return $null }
  }
}
