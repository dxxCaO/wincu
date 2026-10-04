# ============================================================================
# agent-cursor.ps1 - wincu virtual cursor overlay (click-through, never steals
# focus, never moves the real pointer). Driven by a command file so it can be
# started from any backend mode (one-shot or persistent) and outlive the call.
#   -CommandPath <json>  {seq, enabled, x, y, speed, click, theme, quit,
#                         label, trail, reducedMotion, clearTrail}
#   -StatePath   <json>  {pid, seq, x, y, enabled}
# ASCII only on purpose (Windows PowerShell 5.1 + BOM-less files).
# ============================================================================
param(
  [Parameter(Mandatory = $true)][string]$CommandPath,
  [Parameter(Mandatory = $true)][string]$StatePath
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public class WcuCursorForm : Form
{
    public double X = 0, Y = 0, TargetX = 0, TargetY = 0;
    public int Ripple = 0;
    public int Ripple2 = 0;
    public bool CursorVisible = true;
    public string Theme = "default";
    public string Label = "";
    public bool Trail = false;
    public bool ReducedMotion = false;
    public double Speed = 0.28;
    public List<PointF> Path = new List<PointF>();

    public WcuCursorForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.Magenta;
        TransparencyKey = Color.Magenta;
        Size = new Size(72, 72);
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Location = new Point(-300, -300);
        Timer t = new Timer();
        t.Interval = 16;
        t.Tick += delegate(object s, EventArgs e) { Step(); };
        t.Start();
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x00000020 | 0x00080000 | 0x00000080 | 0x08000000;
            return cp;
        }
    }

    public void Step()
    {
        // Only repaint when something actually changed: a 16 ms timer that always
        // invalidates burns ~10% of a core while the overlay sits still.
        bool dirty = false;
        double dx = TargetX - X, dy = TargetY - Y;
        if (ReducedMotion)
        {
            if (X != TargetX || Y != TargetY)
            {
                X = TargetX; Y = TargetY;
                Location = new Point((int)Math.Round(X) - 10, (int)Math.Round(Y) - 10);
                dirty = true;
            }
        }
        else if (Math.Abs(dx) > 0.5 || Math.Abs(dy) > 0.5)
        {
            X += dx * Speed;
            Y += dy * Speed;
            Location = new Point((int)Math.Round(X) - 10, (int)Math.Round(Y) - 10);
            dirty = true;
        }
        if (Trail && !ReducedMotion)
        {
            Path.Add(new PointF((float)X, (float)Y));
            if (Path.Count > 26) { Path.RemoveAt(0); }
            dirty = true;
        }
        else if (Path.Count > 0) { Path.Clear(); dirty = true; }
        if (Ripple > 0) { Ripple--; dirty = true; }
        if (Ripple2 > 0) { Ripple2--; dirty = true; }
        if (dirty) { Invalidate(); }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        if (!CursorVisible) { return; }
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        if (Trail && Path.Count > 1)
        {
            for (int i = 1; i < Path.Count; i++)
            {
                int alpha = (int)(150.0 * i / Path.Count);
                using (Pen tp = new Pen(Color.FromArgb(alpha, 90, 170, 255), 2.0f))
                {
                    g.DrawLine(tp, Path[i - 1].X - Location.X + 10, Path[i - 1].Y - Location.Y + 10,
                                   Path[i].X - Location.X + 10, Path[i].Y - Location.Y + 10);
                }
            }
        }
        Point[] arrow = new Point[] {
            new Point(10, 0), new Point(10, 24), new Point(15, 19), new Point(19, 28),
            new Point(23, 26), new Point(19, 17), new Point(25, 16)
        };
        Color fill = (Theme == "dark") ? Color.FromArgb(240, 25, 25, 25) : Color.FromArgb(240, 255, 255, 255);
        Color edge = (Theme == "dark") ? Color.FromArgb(235, 250, 250, 250) : Color.FromArgb(235, 20, 20, 20);
        using (SolidBrush b = new SolidBrush(fill)) { g.FillPolygon(b, arrow); }
        using (Pen p = new Pen(edge, 1.6f)) { g.DrawPolygon(p, arrow); }
        if (Ripple > 0)
        {
            double k = Ripple / 16.0;
            int r = (int)((1.0 - k) * 26) + 4;
            int alpha = (int)(235 * k);
            using (Pen p2 = new Pen(Color.FromArgb(alpha, 255, 96, 64), 2.6f))
            { g.DrawEllipse(p2, 10 - r, 10 - r, r * 2, r * 2); }
        }
        if (Ripple2 > 0)
        {
            double k2 = Ripple2 / 16.0;
            int r2 = 24 + (int)((1.0 - k2) * 14);
            int alpha2 = (int)(200 * k2);
            using (Pen p3 = new Pen(Color.FromArgb(alpha2, 255, 200, 60), 2.2f))
            { g.DrawEllipse(p3, 10 - r2, 10 - r2, r2 * 2, r2 * 2); }
        }
        if (Label.Length > 0)
        {
            using (Font f = new Font("Segoe UI", 8.5f, FontStyle.Regular))
            using (SolidBrush tb = new SolidBrush(Color.FromArgb(235, 20, 20, 20)))
            using (SolidBrush bg = new SolidBrush(Color.FromArgb(225, 255, 255, 255)))
            {
                SizeF sz = g.MeasureString(Label, f);
                g.FillRectangle(bg, 8, 30, sz.Width + 8, sz.Height + 4);
                g.DrawString(Label, f, tb, 12, 32);
            }
        }
    }
}
'@

$form = New-Object WcuCursorForm
$form.Show()

$state = @{ pid = $PID; seq = -1; x = 0; y = 0; enabled = $false }
$script:lastCmdAt = Get-Date
function Write-WcuState {
  try { ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding UTF8 } catch { }
}
Write-WcuState

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 60
$timer.Add_Tick({
  if (-not (Test-Path $CommandPath)) { return }
  $cmd = $null
  try { $cmd = Get-Content $CommandPath -Raw | ConvertFrom-Json } catch { return }
  if ($null -eq $cmd) { return }
  if ([int]$cmd.seq -eq [int]$state.seq) {
    if (((Get-Date) - $script:lastCmdAt).TotalSeconds -gt 300) {
      $timer.Stop()
      $form.Close()
      [System.Windows.Forms.Application]::ExitThread()
    }
    return
  }
  $script:lastCmdAt = Get-Date
  $state.seq = [int]$cmd.seq
  $names = $cmd.PSObject.Properties.Name
  if ($names -contains 'enabled') { $form.CursorVisible = [bool]$cmd.enabled; $state.enabled = [bool]$cmd.enabled }
  if (($names -contains 'theme') -and $cmd.theme) { $form.Theme = [string]$cmd.theme }
  if (($names -contains 'x') -and ($null -ne $cmd.x)) { $form.TargetX = [double]$cmd.x; $state.x = [int]$cmd.x }
  if (($names -contains 'y') -and ($null -ne $cmd.y)) { $form.TargetY = [double]$cmd.y; $state.y = [int]$cmd.y }
  if (($names -contains 'speed') -and $cmd.speed) { $form.Speed = [double]$cmd.speed }
  if ($names -contains 'click') {
    if ([string]$cmd.click -eq 'double') { $form.Ripple = 16; $form.Ripple2 = 22 }
    elseif ($cmd.click) { $form.Ripple = 16 }
  }
  if ($names -contains 'label') { $form.Label = [string]$cmd.label }
  if ($names -contains 'trail') { $form.Trail = [bool]$cmd.trail }
  if ($names -contains 'reducedMotion') { $form.ReducedMotion = [bool]$cmd.reducedMotion }
  if ($names -contains 'clearTrail') { $form.Path.Clear() }
  Write-WcuState
  if (($names -contains 'quit') -and $cmd.quit) {
    $timer.Stop()
    $form.Close()
    [System.Windows.Forms.Application]::ExitThread()
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
Write-WcuState
