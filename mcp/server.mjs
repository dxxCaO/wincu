#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
// Advertised over MCP serverInfo; derived from package.json so the two
// cannot drift apart between releases.
const SERVER_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version;
  } catch {
    return "0.2.3";
  }
})();
const backendPath = path.join(pluginRoot, "scripts", "windows-uia.ps1");
const powershell = process.env.WINDOWS_CU_POWERSHELL || "powershell.exe";

const skillResources = [
  {
    uri: "windows-computer-use://skill/computer-use",
    name: "Computer Use Workflow and Recovery Playbook",
    mimeType: "text/markdown",
    file: path.join(pluginRoot, "docs", "skills", "computer-use", "SKILL.md")
  }
];

const wikiResources = [
  ...skillResources,
  {
    uri: "windows-computer-use://wiki/home",
    name: "Windows Computer Use Wiki Home",
    mimeType: "text/markdown",
    file: path.join(pluginRoot, "docs", "wiki", "Home.md")
  },
  {
    uri: "windows-computer-use://wiki/architecture",
    name: "Architecture",
    mimeType: "text/markdown",
    file: path.join(pluginRoot, "docs", "wiki", "architecture.md")
  },
  {
    uri: "windows-computer-use://wiki/mac-codex-computer-use",
    name: "Mac Codex Computer Use Notes",
    mimeType: "text/markdown",
    file: path.join(pluginRoot, "docs", "wiki", "mac-codex-computer-use.md")
  },
  {
    uri: "windows-computer-use://wiki/app-technology-matrix",
    name: "App Technology Matrix",
    mimeType: "text/markdown",
    file: path.join(pluginRoot, "docs", "wiki", "app-technology-matrix.md")
  },
  {
    uri: "windows-computer-use://wiki/mcp-tools",
    name: "MCP Tools",
    mimeType: "text/markdown",
    file: path.join(pluginRoot, "docs", "wiki", "mcp-tools.md")
  },
  {
    uri: "windows-computer-use://wiki/safety",
    name: "Safety",
    mimeType: "text/markdown",
    file: path.join(pluginRoot, "docs", "wiki", "safety.md")
  }
];

const windowTargetProperties = {
  windowTitle: {
    type: "string",
    description: "Substring of a top-level window title to target instead of the foreground window."
  },
  processId: {
    type: "integer",
    minimum: 1,
    description: "Process id of a top-level window to target instead of the foreground window."
  },
  nativeWindowHandle: {
    type: "integer",
    minimum: 1,
    description: "Native HWND of a top-level window to target instead of the foreground window."
  },
  activate: {
    type: "boolean",
    default: false,
    description: "Bring the targeted window to the foreground before acting. Honoured by: drag, type_text and keypress (input needs the foreground); element-target resolution in snapshot/accessibility_tree/find/element_info/focus/invoke/set_value; the x/y coordinate paths of click/double_click/move/scroll and element_info; window capture in ocr; move_window (activates the moved window). Ignored by close_window (WM_CLOSE works in the background); activate_window always activates regardless of this flag."
  }
};

const treeViewProperties = {
  viewMode: {
    type: "string",
    enum: ["control", "content", "raw"],
    default: "control",
    description: "UI Automation view used for traversal. control is the default compact app-control tree; content returns end-user content nodes; raw returns provider internals for debugging. Applies to scope resolution and tree walking; element ids of the form uia:rt:* are looked up directly by RuntimeId and bypass view filtering (the value is still validated, but not applied)."
  },
  includeOffscreen: {
    type: "boolean",
    default: false,
    description: "Include UIA elements currently reported as offscreen. Leave false for normal app workflows; set true for debugging or resolving ids from an offscreen-inclusive tree. Like viewMode, this applies to scope resolution and tree walking; uia:rt:* element ids bypass it."
  }
};

const treeDetailProperties = {
  detailLevel: {
    type: "string",
    enum: ["compact", "full"],
    default: "compact",
    description: "compact omits empty or heavyweight metadata on tree nodes; full returns localized type, process id, runtime id, value, and patterns on every node."
  }
};

const coordinateSpaceProperty = {
  space: {
    type: "string",
    enum: ["screen", "window", "client"],
    default: "screen",
    description: "Coordinate space of x/y: 'screen' pixels (default), 'window' = relative to the target window's rect, 'client' = relative to its client area. Non-screen spaces need a window target and are converted to screen pixels internally; the result echoes space/requested/screen/windowLocal/clientLocal."
  }
};

const homingProperty = {
  homing: {
    type: "string",
    enum: ["strict", "auto", "off"],
    default: "strict",
    description: "What to do when the target window moved since it was observed: 'strict' (default) refuses with window_moved so stale coordinates are never fired, 'auto' compensates and reports homed{dx,dy}, 'off' skips the check."
  }
};

const inputPolicyProperty = {
  observationId: { type: "string", description: "Observation this action is based on (from observe/snapshot). Used by bindObservation and by image-point conversions." },
  bindObservation: { type: "boolean", default: false, description: "Refuse the action unless a live, matching observation exists, so acting on a stale view becomes an explicit refusal instead of a silent miss." },
  allowAnyWindow: { type: "boolean", default: false, description: "Skip the point-ownership pre-check that refuses coordinate input aimed at a window other than the target." },
  settle: { type: "boolean", default: true, description: "After committing input, watch the target's pixels until they stop changing and report settleMs." }
};
const evidenceProperty = {
  evidence: {
    type: "boolean",
    default: false,
    description: "Capture a cheap downscaled hash of the target before and after the action and return both (plus a 'changed' flag) in result.evidence. Costs two extra captures per call; a changed flag proves the pixels changed, not that this action caused it."
  }
};

const tools = [
  {
    name: "windows_computer_use_health",
    description: "Check that the Windows UI Automation backend, screenshot capture, and input stack are available.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "windows_computer_use_snapshot",
    description: "Capture a screenshot and a UI Automation tree for the active window or desktop.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        keepTree: { type: "boolean", default: false },
        diffAgainst: { type: "string" },
        scope: { type: "string", enum: ["active_window", "desktop"], default: "active_window" },
        ...windowTargetProperties,
        ...treeViewProperties,
        ...treeDetailProperties,
        includeScreenshot: { type: "boolean", default: true },
        captureWindow: {
          type: "boolean",
          default: false,
          description: "Capture only the target (or foreground) window instead of the whole virtual screen. Uses PrintWindow when supported (works for non-foreground windows) and falls back to the on-screen region (flagged occludedPossible). Much smaller image."
        },
        maxWidth: {
          type: "integer",
          minimum: 0,
          maximum: 7680,
          default: 1600,
          description: "Downscale the screenshot so its width is at most this many pixels (0 = native resolution). The response then carries imageScale + origin so image pixels can be mapped back to screen coordinates."
        },
        maxDepth: { type: "integer", minimum: 0, maximum: 12, default: 5 },
        maxNodes: { type: "integer", minimum: 1, maximum: 2000, default: 250 }
      }
    }
  },
  {
    name: "windows_computer_use_accessibility_tree",
    description: "Read the UI Automation tree without taking a screenshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: { type: "string", enum: ["active_window", "desktop"], default: "active_window" },
        ...windowTargetProperties,
        ...treeViewProperties,
        ...treeDetailProperties,
        maxDepth: { type: "integer", minimum: 0, maximum: 12, default: 6 },
        maxNodes: { type: "integer", minimum: 1, maximum: 3000, default: 500 }
      }
    }
  },
  {
    name: "windows_computer_use_list_windows",
    description: "List top-level windows visible to Windows UI Automation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeInvisible: { type: "boolean", default: false },
        maxWindows: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      }
    }
  },
  {
    name: "windows_computer_use_find",
    description: "Find elements by name, automation id, class name, value text, or control type.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        scope: { type: "string", enum: ["active_window", "desktop"], default: "active_window" },
        ...windowTargetProperties,
        ...treeViewProperties,
        controlType: { type: "string" },
        maxDepth: { type: "integer", minimum: 0, maximum: 12, default: 8 },
        maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 1200 },
        maxResults: { type: "integer", minimum: 1, maximum: 200, default: 25 }
      }
    }
  },
  {
    name: "windows_computer_use_element_info",
    description: "Return UI Automation information for an element id or a screen point.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...coordinateSpaceProperty,
        elementId: { type: "string" },
        ...windowTargetProperties,
        ...treeViewProperties,
        x: { type: "integer" },
        y: { type: "integer" }
      }
    }
  },
  {
    name: "windows_computer_use_click",
    description: "Click a screen coordinate or the center of a UI Automation element. dispatch:'auto' (default) = element clicks use the UIA Invoke/Toggle pattern in the background (no foreground steal), coordinate clicks use foreground SendInput; dispatch:'background' = PostMessage into the target window's queue (no foreground steal, delivery unverified — Chromium/Electron/UWP may drop it, then retry with foreground); dispatch:'foreground' = always foreground SendInput. Raw-coordinate clicks home-correct if the target window moved since it was observed (reported as 'homed').",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...inputPolicyProperty,
        ...homingProperty,
        ...coordinateSpaceProperty,
        ...evidenceProperty,
        elementId: { type: "string" },
        ...windowTargetProperties,
        ...treeViewProperties,
        x: { type: "integer" },
        y: { type: "integer" },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        dispatch: { type: "string", enum: ["auto", "background", "foreground"], default: "auto" }
      }
    }
  },
  {
    name: "windows_computer_use_double_click",
    description: "Double click a screen coordinate or the center of a UI Automation element. Supports the same dispatch modes as click (background posts a real WM_LBUTTONDBLCLK).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...inputPolicyProperty,
        ...homingProperty,
        ...coordinateSpaceProperty,
        ...evidenceProperty,
        elementId: { type: "string" },
        ...windowTargetProperties,
        ...treeViewProperties,
        x: { type: "integer" },
        y: { type: "integer" },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        dispatch: { type: "string", enum: ["auto", "background", "foreground"], default: "auto" }
      }
    }
  },
  {
    name: "windows_computer_use_move",
    description: "Move the mouse pointer to a screen coordinate or the center of an element.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...inputPolicyProperty,
        ...homingProperty,
        ...coordinateSpaceProperty,
        ...evidenceProperty,
        elementId: { type: "string" },
        ...windowTargetProperties,
        ...treeViewProperties,
        x: { type: "integer" },
        y: { type: "integer" }
      }
    }
  },
  {
    name: "windows_computer_use_drag",
    description: "Drag through a path of screen coordinates.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        ...inputPolicyProperty,
        ...homingProperty,
        ...coordinateSpaceProperty,
        ...evidenceProperty,
        ...windowTargetProperties,
        path: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            required: ["x", "y"],
            additionalProperties: false,
            properties: {
              x: { type: "integer" },
              y: { type: "integer" }
            }
          }
        },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" }
      }
    }
  },
  {
    name: "windows_computer_use_scroll",
    description: "Scroll at a screen coordinate or element center. Positive deltaY scrolls down.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...inputPolicyProperty,
        ...homingProperty,
        ...coordinateSpaceProperty,
        ...evidenceProperty,
        elementId: { type: "string" },
        ...windowTargetProperties,
        ...treeViewProperties,
        x: { type: "integer" },
        y: { type: "integer" },
        deltaY: { type: "integer", default: 480 },
        deltaX: { type: "integer", default: 0 }
      }
    }
  },
  {
    name: "windows_computer_use_type_text",
    description: "Type text into the focused control. method:'clipboard' (default) uses clipboard paste (reliable for CJK, restores the clipboard) and needs the target in the foreground; method:'sendinput' sends each character as a KEYEVENTF_UNICODE SendInput event (no clipboard, needs the target in the foreground, best for ASCII/short text); method:'background' posts WM_CHAR straight into the target window's message queue — no clipboard, no foreground steal, delivery unverified. With a window target the result includes verifyValue (the text control's value after typing, truncated to 200 chars).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        delayMs: { type: "integer", minimum: 0, maximum: 1000, default: 0 },
        allowUnfocused: { type: "boolean", default: false, description: "Skip the focus check and type into whatever is focused." },
        activate: { type: "boolean", default: false, description: "Bring the target to the foreground before typing." },
        ...inputPolicyProperty,
        ...evidenceProperty,
        ...windowTargetProperties,
        text: { type: "string" },
        method: { type: "string", enum: ["clipboard", "sendinput", "background"], default: "clipboard" },
        restoreClipboard: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "windows_computer_use_keypress",
    description: "Press a key or key chord, such as Ctrl+L, Enter, Alt+F4, or Shift+Tab. The Windows key is blocked by design. dispatch:'background' supports only a single printable character (posted as WM_CHAR into the target window, no foreground steal); chords and functional keys must use dispatch:'foreground' (SendKeys).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["keys"],
      properties: {
        allowUnfocused: { type: "boolean", default: false, description: "Skip the focus check and type into whatever is focused." },
        activate: { type: "boolean", default: false, description: "Bring the target to the foreground before typing." },
        ...inputPolicyProperty,
        approve: { type: "boolean", default: false, description: "Required for system-level chords (Alt+F4 / Ctrl+Shift+Esc / Ctrl+Alt+Del)." },
        ...evidenceProperty,
        ...windowTargetProperties,
        keys: {
          type: "array",
          minItems: 1,
          items: { type: "string" }
        },
        dispatch: { type: "string", enum: ["foreground", "background"], default: "foreground" }
      }
    }
  },
  {
    name: "windows_computer_use_focus",
    description: "Set keyboard focus to a UI Automation element.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["elementId"],
      properties: {
        ...evidenceProperty,
        elementId: { type: "string" },
        ...windowTargetProperties,
        ...treeViewProperties
      }
    }
  },
  {
    name: "windows_computer_use_invoke",
    description: "Invoke a UI Automation element through Invoke, Toggle, SelectionItem, or ExpandCollapse patterns, with click fallback.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["elementId"],
      properties: {
        ...inputPolicyProperty,
        ...evidenceProperty,
        elementId: { type: "string" },
        ...windowTargetProperties,
        ...treeViewProperties,
        fallbackClick: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "windows_computer_use_set_value",
    description: "Set a UI Automation ValuePattern value, or focus and type as fallback.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["elementId", "value"],
      properties: {
        ...inputPolicyProperty,
        ...evidenceProperty,
        elementId: { type: "string" },
        ...windowTargetProperties,
        ...treeViewProperties,
        value: { type: "string" },
        fallbackType: { type: "boolean", default: true },
        restoreClipboard: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "windows_computer_use_activate_window",
    description: "Bring a top-level window to the foreground by title substring, process id, or native HWND. This tool always activates its target; the shared activate flag cannot suppress it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: windowTargetProperties
    }
  },
  {
    name: "windows_computer_use_wait",
    description: "Wait for a short period before observing the UI again.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...evidenceProperty,
        milliseconds: { type: "integer", minimum: 1, maximum: 30000, default: 500 }
      }
    }
  },
  {
    name: "windows_computer_use_ocr",
    description: "OCR a window (or the whole desktop) with Windows.Media.Ocr — the fallback for UIA-blind apps (games, self-drawn Tk/Qt, RDP, canvases). Returns the full text plus lines with word boxes in SCREEN coordinates, so you can click on OCR'd text. With query, matched words are upgraded to the underlying UIA control for direct invoke/click. Slower than the UIA tree (~1-3s); use it after snapshot/find shows a sparse tree, or when the app is known to be UIA-blind.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...windowTargetProperties,
        scope: { type: "string", enum: ["active_window", "desktop"], default: "active_window" },
        maxWidth: { type: "integer", minimum: 0, maximum: 7680, default: 1920 },
        query: {
          type: "string",
          description: "Optional text to search for in the OCR result (case-insensitive). When set, the response includes query plus matched entries (up to 3) with the hit line, word box, and the UIA control under the hit — enabling invoke/click on real controls in UIA-blind apps."
        }
      }
    }
  },
  {
    name: "windows_computer_use_wait_for",
    description: "Poll server-side until a window appears or disappears (or timeout). Prefer this over wait+check loops: saves round-trips. Returns found + waitedMs (and timedOut when the deadline passed).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["windowTitle"],
      properties: {
        windowTitle: { type: "string" },
        appear: { type: "boolean", default: true },
        timeoutMs: { type: "integer", minimum: 100, maximum: 60000, default: 5000 },
        intervalMs: { type: "integer", minimum: 50, maximum: 5000, default: 250 }
      }
    }
  },
  {
    name: "windows_computer_use_close_window",
    description: "Close a window gracefully by posting WM_CLOSE (the app can veto with a save dialog). Safer than killing the process; use close_window instead of alt+f4 when the app may have unsaved state you want to handle. The shared activate flag is ignored: WM_CLOSE is posted in the background and needs no foreground switch.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: windowTargetProperties
    }
  },
  {
    name: "windows_computer_use_move_window",
    description: "Move (not resize) a window to screen coordinates without activating it. Useful for arranging windows, and it also refreshes the homing cache for coordinate-based actions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: {
        approve: { type: "boolean", default: false, description: "Required for destructive verbs: the call is refused with refused:'approval-required' unless this is true." },
        ...evidenceProperty,
        ...evidenceProperty,
        ...windowTargetProperties,
        x: { type: "integer" },
        y: { type: "integer" }
      }
    }
  },
  {
    name: "windows_computer_use_capabilities",
    description: "Report effective Windows desktop capabilities and their degradations: UIA reachability, screenshot tiers, input paths, OCR backend, DPI + monitor layout, host process integrity (elevated?), agent cursor, observation budget, verification predicates, recording state, and the enforced red lines. Check this before blaming a failed action on coordinates.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        probe: { type: "string", enum: ["safe", "full"], default: "safe", description: "safe returns the cached/lazy capability report; full additionally hints that heavy sub-checks may run." }
      }
    }
  },
  {
    name: "windows_computer_use_target_identity",
    description: "Resolve the structured identity of a target window (hwnd, pid, process name, title, class, rect, monitor, elevation) or of the current foreground window. Use it to prove which window an action will hit when several windows share a similar title.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...windowTargetProperties }
    }
  },
  {
    name: "windows_computer_use_clipboard_read",
    description: "Read the system clipboard: which formats are present, text length and a short preview, optionally the full text or image dimensions. Clipboard content is privacy-sensitive - request the full text only when needed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeText: { type: "boolean", default: true, description: "Include the full text (may be large / sensitive)." },
        includeImage: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "windows_computer_use_clipboard_write",
    description: "Replace the system clipboard with plain text. A reliable transport between apps, and a workaround for fields where synthetic typing is dropped.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string" } }
    }
  },
  {
    name: "windows_computer_use_launch_app",
    description: "Launch an app and wait (bounded) for its top-level window: path (exe), aumid (packaged app), or url. Returns the new pid, process name and the windows that appeared, so the caller does not have to poll list_windows.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Human app name (app-name resolution, e.g. Paint); resolved through the app index." },
        path: { type: "string", description: "Full path to an executable." },
        aumid: { type: "string", description: "Packaged-app AUMID (PackageFamilyName!AppId)." },
        url: { type: "string", description: "URL opened with the default browser." },
        arguments: { type: ["string", "array"], items: { type: "string" }, description: "Command-line arguments (string or array)." },
        workingDirectory: { type: "string" },
        waitMs: { type: "integer", minimum: 0, maximum: 60000, default: 8000, description: "How long to wait for a top-level window to appear." }
      }
    }
  },
  {
    name: "windows_computer_use_kill_app",
    description: "End an app. mode:'close' posts WM_CLOSE to the main window (apps may veto with a save dialog - recommended), mode:'kill' force-terminates (unsaved state is lost). Address by processId, processName, or nativeWindowHandle.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        approve: { type: "boolean", default: false, description: "Required for destructive verbs: the call is refused with refused:'approval-required' unless this is true." },
        mode: { type: "string", enum: ["close", "kill"], default: "close" },
        processId: { type: "integer", minimum: 1 },
        processName: { type: "string", description: "Process name, with or without .exe." },
        nativeWindowHandle: { type: "integer", minimum: 1 },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30000, default: 4000, description: "How long to wait for a graceful close before reporting 'closing'." }
      }
    }
  },
  {
    name: "windows_computer_use_observe",
    description: "Budgeted observation: capture the target window (optionally cropped to a region or an element) and control how much comes back - returnMode 'inline' (image bytes), 'file' (path only) or 'hash' (hash only), plus diffOnly to suppress the image when nothing changed. Returns evidence (hash, byte size, changed flag, changed box) so the caller can prove what it saw without pushing pixels into the context.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        treeDepth: { type: "integer", minimum: 0, maximum: 40, default: 6 },
        scope: { type: "string", enum: ["active_window", "desktop"], default: "active_window" },
        includeScreenshot: { type: "boolean", default: true },
        includeTree: { type: "boolean", default: false },
        maxWidth: { type: "integer", minimum: 120, maximum: 7680, default: 1600 },
        returnMode: { type: "string", enum: ["inline", "file", "hash"], default: "inline" },
        diffOnly: { type: "boolean", default: false, description: "When the capture is byte-identical to the previous observation of the same target, omit the image and report changed:false." },
        region: {
          anyOf: [
            {
              type: "object",
              description: "Crop rectangle in SCREEN pixels (converted to image pixels internally).",
              required: ["x", "y", "width", "height"],
              additionalProperties: false,
              properties: { x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } }
            },
            { type: "string", enum: ["clientArea"], description: "'clientArea' crops to the target window's client area (title bar and borders removed)." }
          ]
        },
        stableMs: { type: "integer", minimum: 0, maximum: 10000, default: 0, description: "Wait until the pixels have been unchanged for this long before the final capture (replaces fixed sleeps)." },
        stableTimeoutMs: { type: "integer", minimum: 200, maximum: 60000, default: 6000 },
        cropToElement: { type: "boolean", default: false },
        elementId: { type: "string", description: "Element id to crop to when cropToElement is set." },
        cropQuery: { type: "string", description: "Find the first matching element by name/automationId and crop to it." },
        maxDepth: { type: "integer", minimum: 0, maximum: 12, default: 4 },
        maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 200 },
        ...windowTargetProperties,
        ...treeViewProperties
      }
    }
  },
  {
    name: "windows_computer_use_agent_cursor",
    description: "Control the virtual agent cursor: a click-through, always-on-top overlay arrow drawn by a separate helper process. It never moves the real mouse pointer and never steals focus, so observations and 'virtual' input stay non-disruptive. Actions: enable/disable, move to (x,y) with a human-like approach animation, pulse a click ripple, switch theme, or report state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", description: "Show or hide the overlay cursor." },
        x: { type: "integer", description: "Target x in screen pixels." },
        y: { type: "integer", description: "Target y in screen pixels." },
        durationMs: { type: "integer", minimum: 0, maximum: 5000, default: 260, description: "Approach time hint (the overlay eases toward the target)." },
        click: { type: "boolean", default: false, description: "Pulse a click ripple at the target." },
        theme: { type: "string", enum: ["default", "dark"], description: "Arrow color scheme." },
        speed: { type: "number", minimum: 0.05, maximum: 1.0, description: "Easing factor per frame." },
        label: { type: "string", description: "Short caption drawn under the arrow, e.g. 'click' or 'typing'." },
        trail: { type: "boolean", default: false, description: "Draw a fading path behind the cursor." },
        clearTrail: { type: "boolean", default: false, description: "Drop the recorded path." },
        reducedMotion: { type: "boolean", default: false, description: "Jump straight to the target instead of easing." },
        state: { type: "boolean", default: false, description: "Only report helper/overlay state." },
        quit: { type: "boolean", default: false, description: "Ask the overlay helper to exit." }
      }
    }
  },
  {
    name: "windows_computer_use_virtual_move",
    description: "Move ONLY the virtual agent cursor to a screen point. No input is sent and the real pointer does not move - use it to point at things while a human keeps the mouse.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        durationMs: { type: "integer", minimum: 0, maximum: 5000, default: 260 },
        theme: { type: "string", enum: ["default", "dark"] },
        label: { type: "string" },
        trail: { type: "boolean", default: true },
        clearTrail: { type: "boolean", default: false },
        reducedMotion: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "windows_computer_use_virtual_click",
    description: "Click at a screen point WITHOUT touching the real pointer: the virtual cursor animates there and the click is delivered into the target window's message queue (background PostMessage). Reported honestly as verified:false - posted input can be dropped by Chromium/Electron/UWP/WinUI, so confirm the effect with verify_state. A refusal never authorizes a foreground retry; ask for the real 'click' tool explicitly if you need foreground SendInput.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: {
        ...inputPolicyProperty,
        x: { type: "integer" },
        y: { type: "integer" },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        durationMs: { type: "integer", minimum: 0, maximum: 5000, default: 260 },
        theme: { type: "string", enum: ["default", "dark"] },
        doubleClick: { type: "boolean", default: false, description: "Post a real double click (WM_LBUTTONDBLCLK) and animate a second ripple." },
        label: { type: "string" },
        trail: { type: "boolean", default: false },
        reducedMotion: { type: "boolean", default: false },
        ...windowTargetProperties
      }
    }
  },
  {
    name: "windows_computer_use_transient_windows",
    description: "List the transient UI the target owns: its last active popup plus every visible top-level window whose owner is the target (menus, dropdowns, modal dialogs). observe already folds these into its state; call this directly for the list without a screenshot.",
    inputSchema: { type: "object", additionalProperties: false, properties: { max: { type: "integer", minimum: 1, maximum: 20, default: 5 }, ...windowTargetProperties } }
  },
  {
    name: "windows_computer_use_tree_query",
    description: "Search an accessibility tree you already have (from snapshot/accessibility_tree) and return only the matching nodes plus their ancestor context, flattened with depth. Cheaper than re-reading a whole tree when you only care about a few controls.",
    inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" }, tree: { type: "array", items: { type: "object" }, description: "Nodes array from a previous snapshot/accessibility_tree result." } } }
  },
  {
    name: "windows_computer_use_point_owner",
    description: "Report which window would actually receive input at a screen point, and whether it is the window you meant. This is the check that catches 'the click landed on whatever was covering the target'.",
    inputSchema: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: { type: "integer" }, y: { type: "integer" }, targetHwnd: { type: "integer", description: "Optional expected window handle to compare against." } } }
  },
  {
    name: "windows_computer_use_element_actions",
    description: "List the accessibility actions an element supports (Invoke, Toggle, Expand, Collapse, Select, Scroll Up/Down/Left/Right, Raise, SetValue, SetRangeValue, Default, SetFocus) without performing any of them.",
    inputSchema: { type: "object", additionalProperties: false, required: ["elementId"], properties: { elementId: { type: "string" }, ...windowTargetProperties } }
  },
  {
    name: "windows_computer_use_secondary_action",
    description: "Invoke a named accessibility action on an element - the escape hatch for controls whose plain click does something different (expand a tree node, scroll a pane, raise a window, run the default action). See element_actions for what is available.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["elementId", "action"],
      properties: {
        elementId: { type: "string" },
        action: { type: "string", description: "Invoke | Toggle | Expand | Collapse | Select | AddToSelection | RemoveFromSelection | Scroll Up | Scroll Down | Scroll Left | Scroll Right | Raise | SetValue | SetRangeValue | Default | SetFocus" },
        value: { type: ["string", "number"], description: "Value for SetValue / SetRangeValue." },
        ...inputPolicyProperty,
        ...windowTargetProperties
      }
    }
  },
  {
    name: "windows_computer_use_drag_start",
    description: "Begin a drag: press the mouse button at a point (or element) and HOLD it. Unlike drag (one fixed path), you can look at the result mid-drag with observe, adjust, and only then release with drag_end. Sessions expire after timeoutSeconds and are released automatically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        elementId: { type: "string" },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        ...coordinateSpaceProperty,
        ...homingProperty,
        ...inputPolicyProperty,
        ...windowTargetProperties
      }
    }
  },
  {
    name: "windows_computer_use_drag_step",
    description: "Move the pointer while a drag is held (from drag_start), interpolating over durationMs. Observe between steps to steer a canvas drag.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: {
        x: { type: "integer" }, y: { type: "integer" },
        durationMs: { type: "integer", minimum: 0, maximum: 5000, default: 200 },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 300, default: 30 },
        ...coordinateSpaceProperty,
        ...windowTargetProperties
      }
    }
  },
  {
    name: "windows_computer_use_drag_end",
    description: "Release the button held by drag_start and report the path summary.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
        expectTimeoutMs: { type: "integer", minimum: 0, maximum: 30000, default: 2500 },
        expect: { type: "array", items: { type: "object" } }, settleMs: { type: "integer", minimum: 0, maximum: 5000, default: 120 } } }
  },
  {
    name: "windows_computer_use_list_apps",
    description: "List installed applications by NAME (Start-menu shortcuts plus packaged apps), with the launch id to use, whether it is running, and a rough recent-use signal. Use this instead of guessing an exe path.",
    inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", description: "Substring filter on the display name." }, max: { type: "integer", minimum: 1, maximum: 200, default: 60 } } }
  },
  {
    name: "windows_computer_use_resolve_app",
    description: "Resolve a human app name (for example 'Paint', 'Notepad', 'Chrome') to a launch id, with alternatives when the match is ambiguous.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" }, max: { type: "integer", minimum: 1, maximum: 20, default: 5 } } }
  },  {
    name: "windows_computer_use_budget",
    description: "Cumulative image and token cost of state reads in this MCP server process.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "windows_computer_use_internals",
    description: "Debug view: baseline cache, cached observations, recording state, active tool groups.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "windows_computer_use_doctor",
    description: "One-call health check for the whole wincu stack: MCP bridge resolvable at the profile root, profile dependency wired, backend alive and persistent, UIA/screenshot/OCR capability, agent-cursor helper, red-line configuration, observation baselines, recording state and the active tool groups. Run this first when tools seem missing or a call behaves oddly.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "windows_computer_use_stats",
    description: "Per-tool call counts, error counts and latency percentiles (p50/p95/max) for this server process - the evidence you need to see which actions are slow or flaky before optimising a workflow.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "windows_computer_use_act",
    description: "Intent-level action with a delivery ladder and built-in verification: it tries semantic (UIA pattern / ValuePattern), then background (PostMessage) and only with allowForeground:true the real-input rung, checking after each rung whether the outcome actually happened - either the expect:[...] predicates (same shape as verify_state) or a pixel change. Returns every rung tried plus why the outcome was or was not accepted, so 'clicked but nothing happened' becomes a reported fact instead of a guess.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        ...inputPolicyProperty,
        action: { type: "string", enum: ["click", "double_click", "type_text", "keypress", "scroll", "set_value", "invoke"] },
        delivery: { type: "string", enum: ["ladder", "semantic", "background", "foreground"], default: "ladder" },
        allowForeground: { type: "boolean", default: false, description: "Add the SendInput rung. Off by default: a refusal never authorizes a foreground retry." },
        expect: {
          type: "array",
          description: "Predicates that must hold for the outcome to count as verified.",
          items: {
            type: "object",
            required: ["kind"],
            properties: {
              kind: { type: "string", enum: ["window_exists", "title_contains", "class_equals", "process_running", "element_present", "element_absent", "element_value", "image_changed"] },
              value: { type: "string" }, query: { type: "string" }, controlType: { type: "string" }, name: { type: "string" },
              processId: { type: "integer" }, elementId: { type: "string" }, match: { type: "string", enum: ["equals", "contains"] }, key: { type: "string" }
            }
          }
        },
        expectTimeoutMs: { type: "integer", minimum: 0, maximum: 30000, default: 2500 },
        elementId: { type: "string" },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        text: { type: "string" },
        keys: { type: "array", items: { type: "string" } },
        deltaX: { type: "integer", default: 0 },
        deltaY: { type: "integer", default: 0 },
        ...coordinateSpaceProperty,
        ...homingProperty,
        ...windowTargetProperties
      }
    }
  },
  {
    name: "windows_computer_use_click_image_point",
    description: "Click at a point expressed in the pixel space of a previous observation's image (downscale and cropping are accounted for), so callers never hand-convert image pixels into screen pixels. Omit observationId to use the most recent observation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["imageX", "imageY"],
      properties: {
        ...inputPolicyProperty,
        observationId: { type: "string", description: "observationId from a previous observe/snapshot result (defaults to the newest)." },
        imageX: { type: "integer" },
        imageY: { type: "integer" },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        delivery: { type: "string", enum: ["background", "foreground"], default: "background" },
        ...windowTargetProperties
      }
    }
  },
  {
    name: "windows_computer_use_describe",
    description: "Text-first vision fallback for models that cannot read images: captures the target, preprocesses it (auto-invert for dark themes, contrast boost, 2x upscale - all of which Windows OCR needs), runs OCR and returns the text plus word boxes. If the host sets WCU_VLM_URL it also asks that OpenAI-compatible vision model the given question and returns its answer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: { type: "string", description: "Optional question for the configured VLM endpoint." },
        backend: { type: "string", enum: ["auto", "ocr", "vlm"], default: "auto" },
        preprocess: { type: "string", enum: ["auto", "none", "invert", "contrast", "upscale2x"], default: "auto" },
        scale: { type: "number", minimum: 0.5, maximum: 4, default: 2 },
        maxWidth: { type: "integer", minimum: 120, maximum: 7680, default: 1600 },
        maxLines: { type: "integer", minimum: 1, maximum: 200, default: 40 },
        scope: { type: "string", enum: ["active_window", "desktop"], default: "active_window" },
        region: {
          type: "object",
          required: ["x", "y", "width", "height"],
          additionalProperties: false,
          properties: { x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } }
        },
        ...windowTargetProperties
      }
    }
  },
  {
    name: "windows_computer_use_record_start",
    description: "Start recording every tool call into a JSONL trace (wcu-trace/1): tool, arguments, timing, outcome and the resolved target identity. Traces can be replayed later, which turns a hand-driven session into a repeatable script.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Destination .jsonl path (default: %TEMP%/wcu-trace-<timestamp>.jsonl)." },
        label: { type: "string" }
      }
    }
  },
  {
    name: "windows_computer_use_record_stop",
    description: "Stop the active trace and return its path, step count and duration.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "windows_computer_use_record_status",
    description: "Report whether a trace is being recorded, where it is, and how many steps it holds.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "windows_computer_use_replay",
    description: "Replay a recorded JSONL trace by re-invoking each step's tool with its recorded arguments. Window targets are re-resolved (hwnd -> pid -> title) so a trace survives app restarts; element ids that went stale are reported instead of silently mis-clicked. Steps that only observe are replayed too, so the trace doubles as evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Trace path from record_stop (defaults to the active/just-finished trace)." },
        dryRun: { type: "boolean", default: false, description: "List the steps without executing them." },
        continueOnError: { type: "boolean", default: false },
        maxSteps: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        filter: { type: "string", description: "Only replay steps whose tool name contains this substring." },
        fromStep: { type: "integer", minimum: 1, description: "1-based first step to replay." },
        toStep: { type: "integer", minimum: 1, description: "1-based last step to replay." },
        vars: { type: "object", description: "Substitute ${name} placeholders inside step arguments, turning a trace into a parameterised script." },
        label: { type: "string" }
      }
    }
  },
  {
    name: "windows_computer_use_verify_state",
    description: "Evaluate predicates against the live desktop and optionally poll until all pass (timeoutMs). Kinds: window_exists, title_contains{value}, class_equals{value}, process_running{name|processId}, element_present{query,controlType?}, element_absent{query}, element_value{query|elementId,value,match:'equals'|'contains'}, image_changed{key}. Each result carries its own evidence, so a caller can close the loop instead of eyeballing another screenshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        predicates: {
          type: "array",
          items: {
            type: "object",
            required: ["kind"],
            properties: {
              kind: { type: "string", enum: ["window_exists", "title_contains", "class_equals", "process_running", "element_present", "element_absent", "element_value", "image_changed"] },
              value: { type: "string" },
              query: { type: "string" },
              controlType: { type: "string" },
              name: { type: "string" },
              processId: { type: "integer" },
              elementId: { type: "string" },
              match: { type: "string", enum: ["equals", "contains"], default: "equals" },
              key: { type: "string", description: "Baseline key for image_changed." },
              scope: { type: "string", enum: ["active_window", "desktop"] },
              maxDepth: { type: "integer" },
              maxNodes: { type: "integer" }
            }
          }
        },
        predicate: { type: "object", description: "Single-predicate shorthand when 'predicates' is omitted." },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30000, default: 0, description: "Poll until all predicates pass or this budget expires." },
        intervalMs: { type: "integer", minimum: 50, maximum: 5000, default: 400 },
        ...windowTargetProperties
      }
    }
  }
];

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

function stripImagePayload(result) {
  if (!result || typeof result !== "object") return result;
  const clone = structuredClone(result);
  if (clone.screenshot?.base64) {
    clone.screenshot.base64 = `<${clone.screenshot.base64.length} base64 chars omitted>`;
  }
  return clone;
}

// ----------------------------------------------------------------------------
// Persistent backend: one long-lived PowerShell process speaking a
// one-JSON-per-line protocol. Repeated actions skip PowerShell startup, .NET
// assembly loading and native-DLL resolution entirely (bench: ~550ms per
// one-shot action -> ~8-50ms hot). If the backend wedges or dies it is
// killed and respawned lazily on the next call.
// ----------------------------------------------------------------------------
let backendProc = null;
let backendNextId = 0;
const backendWaiters = new Map(); // id -> {resolve, reject, timer, proc}
const pendingToolCalls = new Map(); // MCP request id -> {proc}
const retiringBackends = new WeakSet();
const interruptibleActions = new Set(["health", "snapshot", "tree", "list_windows", "find", "element_info", "wait", "ocr", "wait_for"]);

function dispatchNextBackend(proc) {
  if (retiringBackends.has(proc)) return;
  const pending = [...backendWaiters.entries()].filter(([, w]) => w.proc === proc);
  if (pending.some(([, w]) => w.sent)) return;
  const entry = pending[0];
  if (!entry) return;
  const [id, w] = entry;
  w.sent = true;
  proc.stdin.write(JSON.stringify({ id, action: w.action, args: w.args }) + "\n");
}

function cancelBackendRequest(request) {
  const proc = request?.proc;
  const entry = [...backendWaiters.entries()].find(([, w]) => w.request === request);
  if (!proc || !entry) return;
  request.cancelled = true;
  const [id, w] = entry;
  const error = new Error("COMPUTER_USE_CANCELLED");
  if (!w.sent) {
    backendWaiters.delete(id); clearTimeout(w.timer); w.reject(error);
    return;
  }
  // Read tools may activate a target, including an Alt press/release in the
  // foreground helper. Let those calls finish just like explicit input actions.
  if (interruptibleActions.has(w.action) && !w.args?.activate) {
    killBackend(error, proc);
    return;
  }
  // Input routines may currently hold a button/key. Let their key-up cleanup finish,
  // but discard every not-yet-started action and retire this worker immediately after.
  // The existing timeout still bounds cleanup; cancellation does not extend it.
  retiringBackends.add(proc);
  for (const [queuedId, queued] of backendWaiters) {
    if (queued.proc !== proc || queued.sent) continue;
    backendWaiters.delete(queuedId); clearTimeout(queued.timer); queued.reject(error);
  }
}

function failBackendWaiters(error, proc) {
  for (const [id, w] of backendWaiters) {
    if (w.proc !== proc) continue;
    backendWaiters.delete(id);
    clearTimeout(w.timer);
    w.reject(error);
  }
}

function spawnBackend() {
  let backendBuf = "";
  const proc = backendProc = spawn(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-Sta",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      backendPath,
      "-Persistent"
    ],
    {
      cwd: pluginRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  proc.stdout.setEncoding("utf8");
  // Forward backend diagnostics (parse errors, P/Invoke failures, backend
  // tracebacks) to our stderr so they surface in the MCP client's log and in CI.
  proc.stderr.on("data", (chunk) => {
    process.stderr.write(`[wcu-backend] ${chunk}`);
  });
  proc.stdout.on("data", (chunk) => {
    backendBuf += chunk;
    let idx;
    while ((idx = backendBuf.indexOf("\n")) >= 0) {
      const line = backendBuf.slice(0, idx).trim();
      backendBuf = backendBuf.slice(idx + 1);
      if (!line) continue;
      let resp;
      try {
        resp = JSON.parse(line);
      } catch {
        continue;
      }
      const w = backendWaiters.get(resp.id);
      if (!w || w.proc !== proc) continue;
      backendWaiters.delete(resp.id);
      clearTimeout(w.timer);
      // ok:false with an 'error' is a transport/engine failure. ok:false
      // without one is a *meaningful outcome* (act unverified, refused
      // virtual_click, policy refusal) and must reach the caller as data.
      if (resp.ok === false && resp.error) {
        w.reject(new Error(String(resp.error)));
      } else {
        w.resolve(resp);
      }
      if (retiringBackends.has(proc)) killBackend(new Error("COMPUTER_USE_CANCELLED"), proc);
      else dispatchNextBackend(proc);
    }
  });
  proc.stdin.on("error", () => { /* EPIPE when the backend dies; the exit handler fails waiters */ });
  const onDeath = (err) => {
    failBackendWaiters(err || new Error("Backend process exited"), proc);
    if (backendProc === proc) backendProc = null;
  };
  proc.on("error", onDeath);
  proc.on("exit", () => onDeath());
}

function ensureBackend() {
  if (backendProc && retiringBackends.has(backendProc)) throw new Error("COMPUTER_USE_STOPPING");
  if (!backendProc || backendProc.exitCode !== null) {
    spawnBackend();
  }
  return backendProc;
}

let isShuttingDown = false;
let warmInFlight = null;

// The first tool call used to pay PowerShell start-up + assembly loading (~3.4 s).
// Warm the backend in the background so the model never waits for it.
async function warmBackend() {
  if (warmInFlight) return warmInFlight;
  warmInFlight = (async () => {
    try { await runBackend('health', {}, 60000, null); } catch { }
    finally { warmInFlight = null; }
  })();
  return warmInFlight;
}

function scheduleWarmup(delayMs) {
  if (process.env.WCU_PREWARM === '0') return;
  const timer = setTimeout(() => { void warmBackend(); }, delayMs || 0);
  if (timer.unref) timer.unref();
}

// Capabilities probes CDP ports and UIA state; it barely changes within a session.
let capabilitiesCache = { at: 0, value: null };
async function capabilitiesCached(request) {
  const ttl = Number(process.env.WCU_CAPS_TTL_MS || 60000);
  if (capabilitiesCache.value && (Date.now() - capabilitiesCache.at) < ttl) return capabilitiesCache.value;
  const value = await runBackend('capabilities', {}, 60000, request);
  capabilitiesCache = { at: Date.now(), value: value };
  return value;
}
function killBackend(error = new Error("Backend process stopped"), proc = backendProc) {
  if (proc) {
    if (backendProc === proc) backendProc = null;
    failBackendWaiters(error, proc);
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  }
}

  // A timeout/cancel deliberately kills a possibly-wedged backend; paying the
  // 3.4 s start-up again on the next call is not deliberate. Replace it quietly.
  if (!isShuttingDown) scheduleWarmup(250);
function runBackend(action, args = {}, timeoutMs = 30000, request) {
  const proc = ensureBackend();
  if (request) request.proc = proc;
  const id = ++backendNextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!backendWaiters.has(id)) return;
      backendWaiters.delete(id);
      reject(new Error(`Windows Computer Use backend timed out after ${timeoutMs}ms during ${action}`));
      // The wedged call may have stalled the backend loop: kill it and
      // respawn lazily on the next call.
      killBackend(new Error("Backend stopped after another action timed out"), proc);
    }, timeoutMs);
    backendWaiters.set(id, { resolve, reject, timer, proc, request, action, args, sent: false });
    dispatchNextBackend(proc);
  });
}

// Route a merged tool to the engine action it stands for. Everything downstream
// (group gating, approval rules, red lines, point checks, tracing) then works on
// the legacy name, so the merged surface adds no new policy paths.
// A merged entry routes by its `action`. An unrecognised value used to fall
// through to the entry's default tool, which produced unrelated errors
// (action:'key' silently became type_text -> 'text is required.').
function unknownActionRefusal(entryName, act) {
  let allowed = [];
  try {
    const def = mergedTools.find((t) => t.name === entryName);
    const prop = def && def.inputSchema && def.inputSchema.properties ? def.inputSchema.properties.action : null;
    if (prop && Array.isArray(prop.enum)) allowed = prop.enum.slice();
  } catch { }
  return refusalPayload('invalid-action', 'Unsupported action "' + act + '" for ' + entryName.replace('windows_computer_use_', '') + '.', { allowedActions: allowed, hint: 'Pass one of the allowed actions.' });
}
function routeToLegacy(name, args) {
  if (!MERGED_TOOL_NAMES.has(name)) return { tool: name, args: args || {} };
  const a = Object.assign({}, args || {});
  const drop = (k) => { delete a[k]; };
  switch (name) {
    // Identity routes: advertised under their own name, no renaming needed.
    case "windows_computer_use_health":
    case "windows_computer_use_act":
    case "windows_computer_use_observe":
    case "windows_computer_use_describe":
      return { tool: name, args: a };
    case "windows_computer_use_status": {
      const detail = a.detail || "capabilities";
      drop("detail");
      if (detail === "doctor") return { tool: "windows_computer_use_doctor", args: a };
      if (detail === "stats") return { tool: "windows_computer_use_stats", args: a };
      if (detail === "budget") return { tool: "windows_computer_use_budget", args: a };
      if (detail === "internals") return { tool: "windows_computer_use_internals", args: a };
      return { tool: "windows_computer_use_capabilities", args: a };
    }
    case "windows_computer_use_wait": {
      const mode = a.mode || "time";
      drop("mode");
      return { tool: mode === "window" ? "windows_computer_use_wait_for" : "windows_computer_use_wait", args: a };
    }
    case "windows_computer_use_clipboard": {
      const act = a.action || "read";
      drop("action");
      return { tool: act === "write" ? "windows_computer_use_clipboard_write" : "windows_computer_use_clipboard_read", args: a };
    }
    case "windows_computer_use_app": {
      const act = a.action || "list";
      drop("action");
      if (act === "resolve") return { tool: "windows_computer_use_resolve_app", args: a };
      if (act === "launch") return { tool: "windows_computer_use_launch_app", args: a };
      if (act === "kill") return { tool: "windows_computer_use_kill_app", args: a };
      return { tool: "windows_computer_use_list_apps", args: a };
    }
    case "windows_computer_use_window": {
      const act = a.action || "list";
      drop("action");
      if (act === "activate") return { tool: "windows_computer_use_activate_window", args: a };
      if (act === "close") return { tool: "windows_computer_use_close_window", args: a };
      if (act === "move") return { tool: "windows_computer_use_move_window", args: a };
      if (act === "transient") return { tool: "windows_computer_use_transient_windows", args: a };
      if (act === "identity") return { tool: "windows_computer_use_target_identity", args: a };
      return { tool: "windows_computer_use_list_windows", args: a };
    }
    case "windows_computer_use_read": {
      const mode = a.mode || "window";
      drop("mode");
      if (mode === "tree") return { tool: "windows_computer_use_accessibility_tree", args: a };
      if (mode === "find") return { tool: "windows_computer_use_find", args: a };
      if (mode === "element") return { tool: "windows_computer_use_element_info", args: a };
      if (mode === "query") return { tool: "windows_computer_use_tree_query", args: a };
      if (mode === "ocr") return { tool: "windows_computer_use_ocr", args: a };
      return { tool: "windows_computer_use_snapshot", args: a };
    }
    case "windows_computer_use_mouse": {
      const act = a.action || "click";
      const phase = a.phase || "path";
      drop("action");
      drop("phase");
      if (act === "drag") {
        if (phase === "start") return { tool: "windows_computer_use_drag_start", args: a };
        if (phase === "step") return { tool: "windows_computer_use_drag_step", args: a };
        if (phase === "end") return { tool: "windows_computer_use_drag_end", args: a };
        return { tool: "windows_computer_use_drag", args: a };
      }
      if (act === "click" && (typeof a.imageX === "number" || typeof a.imageY === "number")) {
        return { tool: "windows_computer_use_click_image_point", args: a };
      }
      if (act === "double_click") return { tool: "windows_computer_use_double_click", args: a };
      if (act === "move") return { tool: "windows_computer_use_move", args: a };
      if (act === "scroll") return { tool: "windows_computer_use_scroll", args: a };
      return { tool: "windows_computer_use_click", args: a };
    }
    case "windows_computer_use_keyboard": {
      const act = a.action || "type";
      drop("action");
      if (act === "press") return { tool: "windows_computer_use_keypress", args: a };
      if (act === "focus") return { tool: "windows_computer_use_focus", args: a };
      if (act !== "type") return { tool: null, args: a, refusal: unknownActionRefusal("windows_computer_use_keyboard", act) };
      return { tool: "windows_computer_use_type_text", args: a };
    }
    case "windows_computer_use_element": {
      const act = a.action || "actions";
      drop("action");
      if (act === "invoke") return { tool: "windows_computer_use_invoke", args: a };
      if (act === "set_value") return { tool: "windows_computer_use_set_value", args: a };
      if (act === "secondary") {
        a.action = a.secondaryAction;
        drop("secondaryAction");
        return { tool: "windows_computer_use_secondary_action", args: a };
      }
      return { tool: "windows_computer_use_element_actions", args: a };
    }
    case "windows_computer_use_verify": {
      const mode = a.mode || "predicates";
      drop("mode");
      return { tool: mode === "point" ? "windows_computer_use_point_owner" : "windows_computer_use_verify_state", args: a };
    }
    case "windows_computer_use_cursor": {
      const act = a.action || "move";
      drop("action");
      if (act === "move") return { tool: "windows_computer_use_virtual_move", args: a };
      if (act === "click") return { tool: "windows_computer_use_virtual_click", args: a };
      a.enabled = (act === "show");
      a.state = (act === "state");
      a.quit = (act === "quit");
      return { tool: "windows_computer_use_agent_cursor", args: a };
    }
    case "windows_computer_use_record": {
      const act = a.action || "status";
      drop("action");
      if (act === "start") return { tool: "windows_computer_use_record_start", args: a };
      if (act === "stop") return { tool: "windows_computer_use_record_stop", args: a };
      if (act === "replay") return { tool: "windows_computer_use_replay", args: a };
      return { tool: "windows_computer_use_record_status", args: a };
    }
    default:
      return { tool: name, args: a };
  }
}
// A merged entry advertises the union of its actions' parameters. Only the
// parameters the routed action actually declares are forwarded; anything else is
// reported back as ignoredArgs instead of being silently swallowed by the engine.
function filterArgsForAction(toolName, args) {
  const def = mergedTools.find((t) => t.name === toolName) || tools.find((t) => t.name === toolName);
  const props = def && def.inputSchema ? def.inputSchema.properties : null;
  if (!props || !args) return { args: args || {}, dropped: [] };
  const kept = {};
  const dropped = [];
  for (const [k, v] of Object.entries(args)) {
    if (Object.prototype.hasOwnProperty.call(props, k)) kept[k] = v;
    else dropped.push(k);
  }
  return { args: kept, dropped: dropped };
}

// ------------------------------------------------------------- tree diff ----
// Flatten a nested accessibility tree into a keyed map so two observations can be
// compared cheaply. Controls are keyed by automationId when they have one, else by
// controlType+name, with an occurrence suffix for duplicates.
function flattenTree(nodes, out) {
  const list = Array.isArray(nodes) ? nodes : (nodes ? [nodes] : []);
  const seen = Object.create(null);
  const walk = (items) => {
    for (const node of items) {
      if (!node || typeof node !== 'object') continue;
      const base = node.automationId && String(node.automationId).trim()
        ? 'aid:' + node.automationId
        : 'ct:' + (node.controlType || '?') + '|' + (node.name || '');
      seen[base] = (seen[base] || 0) + 1;
      const key = seen[base] > 1 ? base + '#' + seen[base] : base;
      out[key] = {
        name: node.name || '',
        controlType: node.controlType || '',
        bbox: node.boundingBox ? [node.boundingBox.x, node.boundingBox.y, node.boundingBox.width, node.boundingBox.height] : null,
        value: node.value === undefined ? null : node.value
      };
      if (node.children) walk(Array.isArray(node.children) ? node.children : [node.children]);
    }
  };
  walk(list);
  return out;
}

function diffTrees(before, after) {
  const a = flattenTree(before, Object.create(null));
  const b = flattenTree(after, Object.create(null));
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of Object.keys(b)) {
    if (!a[key]) { added.push({ key: key, name: b[key].name, controlType: b[key].controlType }); continue; }
    const x = a[key];
    const y = b[key];
    const moved = JSON.stringify(x.bbox) !== JSON.stringify(y.bbox);
    const valueChanged = JSON.stringify(x.value) !== JSON.stringify(y.value);
    const renamed = x.name !== y.name;
    if (moved || valueChanged || renamed) {
      changed.push({ key: key, name: y.name, renamed: renamed || undefined, valueBefore: valueChanged ? x.value : undefined, valueAfter: valueChanged ? y.value : undefined, bboxBefore: moved ? x.bbox : undefined, bboxAfter: moved ? y.bbox : undefined });
    }
  }
  for (const key of Object.keys(a)) if (!b[key]) removed.push({ key: key, name: a[key].name, controlType: a[key].controlType });
  const cap = 60;
  return {
    counts: { before: Object.keys(a).length, after: Object.keys(b).length, added: added.length, removed: removed.length, changed: changed.length, unchanged: Object.keys(b).length - added.length - changed.length },
    added: added.slice(0, cap),
    removed: removed.slice(0, cap),
    changed: changed.slice(0, cap),
    truncated: (added.length > cap || removed.length > cap || changed.length > cap) || undefined
  };
}

function applyTreeDiff(result, args) {
  try {
    const text = textOf(result);
    if (!text) return result;
    const parsed = JSON.parse(text);
    const baseline = observationRegistry.get(args.diffAgainst);
    if (!baseline) { parsed.treeDiffError = 'No observation named ' + args.diffAgainst + ' is known (it may have expired).'; return { content: [{ type: 'text', text: safeJson(parsed) }] }; }
    if (!baseline.tree) { parsed.treeDiffError = 'Observation ' + args.diffAgainst + ' carries no accessibility tree to diff against.'; return { content: [{ type: 'text', text: safeJson(parsed) }] }; }
    if (!parsed.tree) { parsed.treeDiffError = 'This read returned no tree.'; return { content: [{ type: 'text', text: safeJson(parsed) }] }; }
    parsed.treeDiff = diffTrees(baseline.tree, parsed.tree);
    parsed.treeDiff.against = args.diffAgainst;
    if (args.keepTree !== true) { delete parsed.tree; parsed.treeDiffNote = 'The full tree was replaced by treeDiff; pass keepTree:true to also receive it.'; }
    return { content: [{ type: 'text', text: safeJson(parsed) }] };
  } catch { return result; }
}
// ------------------------------------------------------- budget + internals --
const budgetStats = { reads: 0, inlineImages: 0, estimatedTokens: 0, bytes: 0, since: new Date().toISOString() };

function recordBudget(parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  budgetStats.reads++;
  if (typeof parsed.tokenEstimate === 'number') budgetStats.estimatedTokens += parsed.tokenEstimate;
  const shot = parsed.screenshot;
  if (shot) {
    if (typeof shot.bytes === 'number') budgetStats.bytes += shot.bytes;
    if (shot.base64 || parsed.returnMode === 'inline') budgetStats.inlineImages++;
  }
}

function budgetReport() {
  const mb = budgetStats.bytes / (1024 * 1024);
  return {
    ok: true,
    action: "budget",
    since: budgetStats.since,
    stateReads: budgetStats.reads,
    inlineImages: budgetStats.inlineImages,
    estimatedImageTokens: budgetStats.estimatedTokens,
    capturedBytes: budgetStats.bytes,
    capturedMB: Number(mb.toFixed(2)),
    trackedObservations: observationRegistry.size,
    note: "Cumulative image cost of state reads in this MCP server process. Prefer returnMode:'hash', region:'clientArea' or diffOnly when you only need to know whether something changed."
  };
}

async function internalsReport(request) {
  const out = { ok: true, action: "internals" };
  try { out.baselines = await runBackend('baselines', {}, 15000, request); } catch (e) { out.baselinesError = String(e.message).slice(0, 200); }
  try { out.cachedObservations = await runBackend('observations', {}, 15000, request); } catch (e) { out.observationsError = String(e.message).slice(0, 200); }
  out.registry = [...observationRegistry.values()].map((r) => ({ id: r.id, targetKey: r.targetKey, hwnd: r.hwnd, kind: r.kind, hasTree: !!r.tree, invalidated: r.invalidated }));
  out.recording = traceStatus();
  out.toolGroups = enabledToolGroups() || "all";
  return out;
}
function noteIgnoredArgs(result, toolName, dropped) {
  if (!dropped || dropped.length === 0) return result;
  try {
    const text = textOf(result);
    if (!text) return result;
    const parsed = JSON.parse(text);
    const action = toolName.replace('windows_computer_use_', '');
    parsed.ignoredArgs = dropped;
    parsed.ignoredArgsNote = 'These parameters do not apply to ' + action + ' and were not forwarded: ' + dropped.join(', ') + '. See the tool description for which parameters each action takes.';
    return { content: [{ type: 'text', text: safeJson(parsed) }] };
  } catch { return result; }
}
async function dispatchTool(name, args, request) {
  switch (name) {
    case "windows_computer_use_health":
      return backendText("health", args, undefined, request);
    case "windows_computer_use_snapshot": {
      // Budgeted observations are served by the extension action 'observe'.
      const budgeted = !!(args && (args.region || args.cropToElement || args.diffOnly || (args.returnMode && args.returnMode !== "inline")));
      const result = await runBackend(budgeted ? "observe" : "snapshot", args, 60000, request);
      return imageContent(result, args);
    }
    case "windows_computer_use_observe": {
      const result = await runBackend("observe", args, 60000, request);
      return imageContent(result, args);
    }
    case "windows_computer_use_verify_state":
      return backendText("verify_state", args, Math.max(30000, Number(args?.timeoutMs || 0) + 20000), request);
    case "windows_computer_use_agent_cursor":
      return backendText("agent_cursor", args, 30000, request);
    case "windows_computer_use_virtual_move":
      return backendText("virtual_move", args, 30000, request);
    case "windows_computer_use_virtual_click":
      return backendText("virtual_click", args, 30000, request);
    case "windows_computer_use_doctor":
      return { content: [{ type: "text", text: safeJson(await doctorReport(request)) }] };
    case "windows_computer_use_budget":
      return { content: [{ type: "text", text: safeJson(budgetReport()) }] };
    case "windows_computer_use_internals":
      return { content: [{ type: "text", text: safeJson(await internalsReport(request)) }] };
    case "windows_computer_use_stats":
      return { content: [{ type: "text", text: safeJson(statsReport()) }] };
    case "windows_computer_use_act":
      return backendText("act", args, Math.max(40000, Number(args?.expectTimeoutMs || 2500) + 30000), request);
    case "windows_computer_use_click_image_point":
      return backendText("click_image_point", args, 45000, request);
    case "windows_computer_use_describe":
      return backendText("describe", args, 120000, request);
    case "windows_computer_use_record_start":
      return { content: [{ type: "text", text: safeJson(traceStart(args)) }] };
    case "windows_computer_use_record_stop":
      return { content: [{ type: "text", text: safeJson(traceStop()) }] };
    case "windows_computer_use_record_status":
      return { content: [{ type: "text", text: safeJson(traceStatus()) }] };
    case "windows_computer_use_replay":
      return { content: [{ type: "text", text: safeJson(await traceReplay(args, request)) }] };
    case "windows_computer_use_accessibility_tree":
      return backendText("tree", args, 45000, request);
    case "windows_computer_use_list_windows":
      return backendText("list_windows", args, undefined, request);
    case "windows_computer_use_find":
      return backendText("find", args, 45000, request);
    case "windows_computer_use_element_info": {
      const info = await backendText("element_info", args, undefined, request);
      return await enrichElementInfo(info, request);
    }
    case "windows_computer_use_click":
      return backendText("click", args, undefined, request);
    case "windows_computer_use_double_click":
      return backendText("double_click", args, undefined, request);
    case "windows_computer_use_move":
      return backendText("move", args, undefined, request);
    case "windows_computer_use_drag":
      return backendText("drag", args, undefined, request);
    case "windows_computer_use_scroll":
      return backendText("scroll", args, undefined, request);
    case "windows_computer_use_type_text":
      return backendText("type_text", args, undefined, request);
    case "windows_computer_use_keypress":
      return backendText("keypress", args, undefined, request);
    case "windows_computer_use_focus":
      return backendText("focus", args, undefined, request);
    case "windows_computer_use_invoke":
      return backendText("invoke", args, undefined, request);
    case "windows_computer_use_set_value":
      return backendText("set_value", args, undefined, request);
    case "windows_computer_use_activate_window":
      return backendText("activate_window", args, undefined, request);
    case "windows_computer_use_wait":
      return backendText("wait", args, Math.max(31000, Number(args?.milliseconds || 500) + 1000), request);
    case "windows_computer_use_ocr":
      return backendText("ocr", args, 60000, request);
    case "windows_computer_use_wait_for":
      return backendText("wait_for", args, Math.max(31000, Number(args?.timeoutMs || 5000) + 2000), request);
    case "windows_computer_use_close_window":
      return backendText("close_window", args, undefined, request);
    case "windows_computer_use_move_window":
      return backendText("move_window", args, undefined, request);
    case "windows_computer_use_capabilities":
      return { content: [{ type: "text", text: safeJson(await capabilitiesCached(request)) }] };
    case "windows_computer_use_target_identity":
      return backendText("target_identity", args, 20000, request);
    case "windows_computer_use_clipboard_read":
      return backendText("clipboard_read", args, 15000, request);
    case "windows_computer_use_clipboard_write":
      return backendText("clipboard_write", args, 15000, request);
    case "windows_computer_use_launch_app": {
      const resolvedTarget = await resolveLaunchTarget(args, request);
      if (resolvedTarget.refusal) return resolvedTarget.refusal;
      try {
        return await backendText("launch_app", resolvedTarget.args, Math.max(25000, Number(resolvedTarget.args?.waitMs || 8000) + 15000), request);
      } catch (error) {
        return refusalPayload("app-launch-failed", "The launcher could not start the target.", {
          requested: { appName: resolvedTarget.args.appName || null, path: resolvedTarget.args.path || null, aumid: resolvedTarget.args.aumid || null, url: resolvedTarget.args.url || null },
          engineError: String(error.message).slice(0, 300),
          hint: "Check the id with app {action:\"resolve\"} or list apps; packaged apps need their AUMID, URLs need a scheme such as ms-settings:."
        });
      }
    }
    case "windows_computer_use_kill_app":
      return backendText("kill_app", args, Math.max(20000, Number(args?.timeoutMs || 4000) + 12000), request);
    case "windows_computer_use_transient_windows":
      return backendText("transient_windows", args, 30000, request);
    case "windows_computer_use_tree_query":
      return backendText("tree_query", args, 20000, request);
    case "windows_computer_use_point_owner":
      return backendText("point_owner", args, 20000, request);
    case "windows_computer_use_element_actions":
      return backendText("element_actions", args, 20000, request);
    case "windows_computer_use_secondary_action":
      return backendText("secondary_action", args, 30000, request);
    case "windows_computer_use_drag_start":
      return backendText("drag_start", args, 30000, request);
    case "windows_computer_use_drag_step":
      return backendText("drag_step", args, 30000, request);
    case "windows_computer_use_drag_end":
      return backendText("drag_end", args, 20000, request);
    case "windows_computer_use_list_apps":
      return backendText("list_apps", args, 60000, request);
    case "windows_computer_use_resolve_app":
      return backendText("resolve_app", args, 60000, request);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================================
// Compact public surface (v0.3.3): 16 merged tools instead of 52 fine-grained
// ones. Capabilities are unchanged - every merged action routes to the same
// engine action as before; only the advertised entry points (and therefore the
// per-request prompt cost) shrink. The old names stay callable for scripts.
// ============================================================================

const compactTarget = {
  windowTitle: { type: "string", description: "Window title substring." },
  processId: { type: "integer", description: "Target process id." },
  nativeWindowHandle: { type: "integer", description: "Target HWND (most precise)." }
};

const compactPolicy = {
  observationId: { type: "string", description: "Observation this act is based on." },
  bindObservation: { type: "boolean", default: false, description: "Refuse unless a live matching observation exists." },
  allowAnyWindow: { type: "boolean", default: false, description: "Skip the point-ownership pre-check." },
  settle: { type: "boolean", default: true, description: "Wait for the pixels to stop changing after committing input." }
};

const compactPoint = {
  x: { type: "integer", description: "X in the given space." },
  y: { type: "integer", description: "Y in the given space." },
  space: { type: "string", enum: ["screen", "window", "client"], default: "screen", description: "'screen' pixels, 'window' rect-relative, or 'client' area-relative." },
  homing: { type: "string", enum: ["strict", "auto", "off"], default: "strict", description: "What to do when the window moved since it was observed." }
};

const mergedTools = [
  {
    name: "windows_computer_use_health",
    description: "Backend liveness and UIA/screenshot availability.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  },
  {
    name: "windows_computer_use_read",
    description: "Read state: mode window (screenshot + tree) | tree | find (search controls) | element (one control, by id or point) | query (filter a tree you already have) | ocr (recognised text for canvas-like apps).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        keepTree: { type: "boolean", default: false, description: "Keep the full tree alongside treeDiff." },
        diffAgainst: { type: "string", description: "observationId to diff against: the raw tree is replaced by added/removed/changed controls." },
        mode: { type: "string", enum: ["window", "tree", "find", "element", "query", "ocr"], default: "window" },
        includeScreenshot: { type: "boolean", default: true, description: "mode 'window'." },
        maxDepth: { type: "integer", minimum: 0, maximum: 40, description: "Tree depth limit." },
        viewMode: { type: "string", enum: ["control", "content", "raw"], default: "control" },
        includeOffscreen: { type: "boolean", default: false },
        query: { type: "string", description: "mode 'find'/'query'/'ocr': case-insensitive substring." },
        tree: { type: "array", items: { type: "object" }, description: "mode 'query': nodes array from an earlier read." },
        elementId: { type: "string", description: "mode 'element'." },
        x: { type: "integer", description: "mode 'element': screen point to inspect." },
        y: { type: "integer" },
        scope: { type: "string", enum: ["active_window", "desktop"], default: "active_window", description: "mode 'ocr'." },
        maxLines: { type: "integer", minimum: 1, maximum: 200, default: 40 },
        ...compactTarget
      }
    }
  },
  {
    name: "windows_computer_use_mouse",
    description: "Pointer input. action: click | double_click | move | scroll | drag. Targets an elementId, x/y (+space), or a point in an earlier screenshot (imageX/imageY + observationId). drag phase: path (default) | start | step | end (steer a canvas drag with observe calls in between).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        expectTimeoutMs: { type: "integer", minimum: 0, maximum: 30000, default: 2500 },
        expect: { type: "array", items: { type: "object" }, description: "drag phase end: predicates that must hold afterwards." },
        action: { type: "string", enum: ["click", "double_click", "move", "scroll", "drag"], default: "click" },
        phase: { type: "string", enum: ["path", "start", "step", "end"], default: "path", description: "action 'drag' only." },
        elementId: { type: "string" },
        imageX: { type: "integer", description: "Point inside the image of a previous observation." },
        imageY: { type: "integer" },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        dispatch: { type: "string", enum: ["auto", "background", "foreground"], default: "auto", description: "auto = UIA/background first, foreground only when asked explicitly." },
        activate: { type: "boolean", default: false, description: "Bring the target forward before acting." },
        deltaX: { type: "integer", default: 0, description: "action 'scroll'." },
        deltaY: { type: "integer", default: 480, description: "action 'scroll'." },
        path: { type: "array", items: { type: "object", required: ["x", "y"], properties: { x: { type: "integer" }, y: { type: "integer" } } }, description: "action 'drag', phase 'path'." },
        durationMs: { type: "integer", minimum: 0, maximum: 5000, default: 200, description: "Glide time for drag step/end." },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 300, default: 30, description: "Drag session lifetime; the button is released on expiry." },
        ...compactPoint,
        ...compactPolicy,
        ...compactTarget
      }
    }
  },
  {
    name: "windows_computer_use_keyboard",
    description: "Keyboard input. action: 'type' (text into the focus), 'press' (a +-separated chord such as Control_L+s), 'focus' (move keyboard focus to an element).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        restoreClipboard: { type: "boolean", default: true, description: "Put the previous clipboard text back after a paste." },
        delayMs: { type: "integer", minimum: 0, maximum: 1000, default: 0, description: "Pace the keystrokes one character at a time (sendinput only) for targets that drop fast bursts." },
        method: { type: "string", enum: ["clipboard", "sendinput", "background"], default: "clipboard", description: "clipboard = paste (restores clipboard) | sendinput = Unicode keys (works in password fields) | background = WM_CHAR into the window (no focus, unverified)." },
        activate: { type: "boolean", default: false, description: "Focus/raise the target before typing (checked: typing into the wrong window is refused)." },
        allowUnfocused: { type: "boolean", default: false, description: "Skip that focus check." },
        action: { type: "string", enum: ["type", "press", "focus"], default: "type" },
        text: { type: "string", description: "action 'type'." },
        keys: { type: "array", items: { type: "string" }, description: "action 'press', e.g. ['Control_L','s'] or ['Return']." },
        elementId: { type: "string", description: "action 'focus'." },
        ...compactPolicy,
        ...compactTarget
      }
    }
  },
  {
    name: "windows_computer_use_act",
    description: "Do one thing and prove it: semantic (UIA) then background (PostMessage) then, only with allowForeground:true, real input - checking after each rung whether expect holds or the pixels changed. Returns every rung tried.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["click", "double_click", "type_text", "keypress", "scroll", "set_value", "invoke"] },
        delivery: { type: "string", enum: ["ladder", "semantic", "background", "foreground"], default: "ladder" },
        allowForeground: { type: "boolean", default: false },
        expect: { type: "array", items: { type: "object" }, description: "Predicates that must hold (same shape as verify)." },
        expectTimeoutMs: { type: "integer", minimum: 0, maximum: 30000, default: 2500 },
        elementId: { type: "string" },
        text: { type: "string" },
        keys: { type: "array", items: { type: "string" } },
        ...compactPoint,
        ...compactPolicy,
        ...compactTarget
      }
    }
  },
  {
    name: "windows_computer_use_element",
    description: "Accessibility actions on one element. action: 'actions' (list what it supports), 'invoke' (its primary action), 'set_value', 'secondary' (a named action such as Expand, Collapse, Scroll Down, Raise, Select, Default).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["elementId"],
      properties: {
        action: { type: "string", enum: ["actions", "invoke", "set_value", "secondary"], default: "actions" },
        elementId: { type: "string" },
        value: { type: ["string", "number"], description: "action 'set_value'." },
        secondaryAction: { type: "string", description: "action 'secondary', e.g. 'Expand'." },
        ...compactPolicy,
        ...compactTarget
      }
    }
  },
  {
    name: "windows_computer_use_window",
    description: "Window housekeeping. action: 'list' | 'activate' | 'close' | 'move' | 'transient' (menus/dialogs owned by the target) | 'identity' (structured hwnd/pid/title/class/monitor/elevation).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "activate", "close", "move", "transient", "identity"], default: "list" },
        x: { type: "integer", description: "action 'move'." },
        y: { type: "integer" },
        width: { type: "integer" },
        height: { type: "integer" },
        max: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        approve: { type: "boolean", default: false, description: "Required by action 'close'." },
        ...compactTarget, ...compactPoint
      }
    }
  },
  {
    name: "windows_computer_use_app",
    description: "Applications by name. action: 'list' | 'resolve' (name -> launch id) | 'launch' (path, AUMID/URL, or app name) | 'kill' (close politely, or mode:'kill' with approve:true).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "resolve", "launch", "kill"], default: "list" },
        query: { type: "string", description: "action 'list': name filter." },
        name: { type: "string", description: "action 'resolve'/'launch': human app name, e.g. Paint." },
        path: { type: "string", description: "action 'launch': exe path or URL." },
        waitMs: { type: "integer", default: 8000 },
        mode: { type: "string", enum: ["close", "kill"], default: "close", description: "action 'kill'." },
        processId: { type: "integer" },
        processName: { type: "string" },
        approve: { type: "boolean", default: false },
        max: { type: "integer", minimum: 1, maximum: 200, default: 60 }
      }
    }
  },
  {
    name: "windows_computer_use_clipboard",
    description: "Clipboard bridge. action: 'read' (formats + text/image) | 'write' (plain text).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["read", "write"], default: "read" },
        text: { type: "string", description: "action 'write'." },
        includeText: { type: "boolean", default: true },
        includeImage: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "windows_computer_use_observe",
    description: "Budgeted look at the target: crop to a region or the client area, return the image inline/file/hash-only, skip the image when nothing changed, wait for the pixels to settle, and get an observationId plus a token estimate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        treeDepth: { type: "integer", minimum: 0, maximum: 40, default: 6 },
        includeTree: { type: "boolean", default: false, description: "Capture the accessibility tree in the same call as the image." },
        returnMode: { type: "string", enum: ["inline", "file", "hash", "auto"], default: "auto" },
        region: { type: "string", enum: ["clientArea"], description: "Or pass an object {x,y,width,height} in screen pixels." },
        diffOnly: { type: "boolean", default: false, description: "Omit the image when the target is unchanged." },
        stableMs: { type: "integer", minimum: 0, maximum: 10000, default: 0, description: "Wait until the pixels have been unchanged this long." },
        stableTimeoutMs: { type: "integer", minimum: 200, maximum: 4000, default: 1500, description: "Budget for the stability probe; the loop is bounded by stableMaxProbes captures." },
        stableMaxProbes: { type: "integer", minimum: 1, maximum: 20, default: 8 },
        allowAnyObservation: { type: "boolean", default: false, description: "With bindObservation: accept the newest observation for this target when no id was given." },
        maxWidth: { type: "integer", minimum: 120, maximum: 7680, default: 1600 },
        transient: { type: "boolean", default: true, description: "Also capture menus/dialogs the target owns." },
        cropToElement: { type: "string", description: "Crop to this element id." },
        scope: { type: "string", enum: ["active_window", "desktop"], default: "active_window" },
        ...compactTarget
      }
    }
  },
  {
    name: "windows_computer_use_verify",
    description: "Close the loop. mode 'predicates': poll window_exists / title_contains / class_equals / process_running / element_present / element_absent / element_value / image_changed until all hold. mode 'point': report which window would receive input at a screen point and whether it is the one you meant.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["predicates", "point"], default: "predicates" },
        predicates: { type: "array", items: { type: "object" }, description: "mode 'predicates'; each needs a 'kind'." },
        timeoutMs: { type: "integer", minimum: 0, maximum: 120000, default: 4000 },
        intervalMs: { type: "integer", minimum: 50, maximum: 5000, default: 300 },
        x: { type: "integer", description: "mode 'point'." },
        y: { type: "integer" },
        targetHwnd: { type: "integer", description: "mode 'point': expected window." },
        ...compactTarget
      }
    }
  },
  {
    name: "windows_computer_use_cursor",
    description: "Virtual agent cursor: an overlay arrow from a separate process that never moves the real pointer or steals focus. action: show | hide | move | click (background post, honest verified:false) | state | quit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["show", "hide", "move", "click", "state", "quit"], default: "move" },
        x: { type: "integer" }, y: { type: "integer" },
        doubleClick: { type: "boolean", default: false },
        label: { type: "string", description: "Short caption drawn under the arrow." },
        trail: { type: "boolean", default: false },
        reducedMotion: { type: "boolean", default: false },
        theme: { type: "string", enum: ["default", "dark"] },
        speed: { type: "number", minimum: 0.05, maximum: 1 },
        durationMs: { type: "integer", minimum: 0, maximum: 5000, default: 260 },
        ...compactPolicy,
        ...compactTarget
      }
    }
  },
  {
    name: "windows_computer_use_record",
    description: "Trace and replay. action: start | stop | status | replay. Replay re-resolves windows (hwnd->pid->title) and elements (id->automationId->name), substitutes vars, and flags outcome drift.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["start", "stop", "status", "replay"], default: "status" },
        path: { type: "string", description: "Trace file (jsonl)." },
        label: { type: "string" },
        dryRun: { type: "boolean", default: false },
        vars: { type: "object", description: "Substitute placeholders inside step arguments." },
        fromStep: { type: "integer", minimum: 1 },
        toStep: { type: "integer", minimum: 1 },
        filter: { type: "string" },
        continueOnError: { type: "boolean", default: false },
        maxSteps: { type: "integer", minimum: 1, maximum: 500, default: 100 }
      }
    }
  },
  {
    name: "windows_computer_use_describe",
    description: "Text-first vision fallback: capture, auto-invert dark themes, boost contrast, upscale 2x, then OCR into text plus word boxes. Set WCU_VLM_URL to also ask a vision model the question.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: { type: "string" },
        backend: { type: "string", enum: ["auto", "ocr", "vlm"], default: "auto" },
        preprocess: { type: "string", enum: ["auto", "none", "invert", "contrast", "upscale2x"], default: "auto" },
        maxLines: { type: "integer", minimum: 1, maximum: 200, default: 40 },
        scope: { type: "string", enum: ["active_window", "desktop"], default: "active_window" },
        ...compactTarget
      }
    }
  },
  {
    name: "windows_computer_use_status",
    description: "Self-diagnostics. detail: capabilities | doctor (health with fixes) | stats (latency, error rates) | budget (observation spend so far) | internals (baselines, cached observations).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { detail: { type: "string", enum: ["capabilities", "doctor", "stats", "budget", "internals"], default: "capabilities" } }
    }
  },
  {
    name: "windows_computer_use_wait",
    description: "Wait. mode 'time' sleeps milliseconds (0 = yield); mode 'window' polls until a window appears/disappears.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["time", "window"], default: "time" },
        milliseconds: { type: "integer", minimum: 0, default: 1 },
        present: { type: "boolean", default: true, description: "mode 'window': wait for it to appear (true) or vanish (false)." },
        timeoutMs: { type: "integer", minimum: 0, maximum: 120000, default: 15000 },
        ...compactTarget
      }
    }
  }
];

const MERGED_TOOL_NAMES = new Set(mergedTools.map((t) => t.name));
const TOOL_GROUPS = {
  vision: ["windows_computer_use_describe"],
  cursor: ["windows_computer_use_agent_cursor", "windows_computer_use_virtual_move", "windows_computer_use_virtual_click", "windows_computer_use_cursor"],
  record: ["windows_computer_use_record_start", "windows_computer_use_record_stop", "windows_computer_use_record_status", "windows_computer_use_replay", "windows_computer_use_record"],
  dev: ["windows_computer_use_doctor", "windows_computer_use_stats", "windows_computer_use_status"]
};

function enabledToolGroups() {
  const raw = process.env.WCU_TOOL_GROUPS;
  if (!raw) return null;                       // null = every group enabled
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function toolVisible(name) {
  const groups = enabledToolGroups();
  if (!groups) return true;
  for (const [group, names] of Object.entries(TOOL_GROUPS)) {
    if (names.includes(name) && !groups.includes(group)) return false;
  }
  return true;
}

const EVIDENCE_ACTIONS = new Set([
  "click", "double_click", "move", "drag", "scroll", "type_text", "keypress",
  "invoke", "set_value", "focus", "activate_window", "close_window", "move_window"
]);

function imageContent(result, args) {
  const content = [{ type: "text", text: safeJson(stripImagePayload(result)) }];
  if ((args?.includeScreenshot ?? true) && result?.screenshot?.base64) {
    content.push({ type: "image", data: result.screenshot.base64, mimeType: "image/png" });
  }
  return { content };
}

async function backendText(action, args, timeoutMs, request) {
  if (args && args.evidence === true && EVIDENCE_ACTIONS.has(action)) {
    const target = { windowTitle: args.windowTitle, processId: args.processId, nativeWindowHandle: args.nativeWindowHandle };
    let before = null;
    try { before = await runBackend("capture_hash", target, 20000, null); } catch { before = null; }
    const result = await runBackend(action, args, timeoutMs, request);
    let after = null;
    try { after = await runBackend("capture_hash", target, 20000, null); } catch { after = null; }
    result.evidence = {
      screenshotBefore: before?.hash ?? null,
      screenshotAfter: after?.hash ?? null,
      changed: before && after ? before.hash !== after.hash : null,
      capture: "downscaled window capture (maxWidth 480), sha256",
      note: "changed:true means the target's pixels differ after the action; it does not prove this action caused it."
    };
    return { content: [{ type: "text", text: safeJson(stripImagePayload(result)) }] };
  }
  const result = await runBackend(action, args, timeoutMs, request);
  return { content: [{ type: "text", text: safeJson(stripImagePayload(result)) }] };
}


// ---------------------------------------------------------------- policy: red lines
const RED_LINE_PROCESSES = [
  "cmd", "powershell", "pwsh", "windowsterminal", "wt", "conhost", "openconsole", "mintty",
  "bash", "wsl", "regedit", "taskmgr", "mmc", "consent", "logonui", "credwiz",
  "keepass", "1password", "bitwarden", "lastpass", "dashlane", "procexp", "procmon"
];
const RED_LINE_CLASSES = [
  "ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "TaskManagerWindow", "Credential Dialog Xaml Host"
];
// Red lines gate INPUT-sending tools only: launching or ending a process the
// caller named explicitly is not "driving" it, and window management is not
// input either. Everything that types, clicks, or key-presses into a target
// goes through this list.
// Destructive verbs need an explicit approve:true from the caller.
const APPROVAL_RULES = [
  { tool: "windows_computer_use_kill_app", when: (a) => a?.mode === "kill", why: "mode:'kill' force-terminates the process and can lose unsaved work." },
  { tool: "windows_computer_use_close_window", when: () => true, why: "Closing a window may discard unsaved work (the app can veto, but only if it is asked)." },
  { tool: "windows_computer_use_keypress", when: (a) => /alt.*f4|ctrl.*shift.*esc|ctrl.*alt.*del/i.test(JSON.stringify(a?.keys ?? a?.sendChord ?? "")), why: "System-level chords (Alt+F4 / Ctrl+Shift+Esc / Ctrl+Alt+Del) are destructive." }
];

const INPUT_TOOL_NAMES = new Set([
  "windows_computer_use_click", "windows_computer_use_double_click", "windows_computer_use_move",
  "windows_computer_use_drag", "windows_computer_use_scroll", "windows_computer_use_type_text",
  "windows_computer_use_keypress", "windows_computer_use_invoke", "windows_computer_use_set_value",
  "windows_computer_use_focus", "windows_computer_use_virtual_click"
]);

async function redLineRefusal(name, args, ctx) {
  if (process.env.WCU_ALLOW_REDLINES === "1") return null;
  if (!INPUT_TOOL_NAMES.has(name)) return null;
  let target = null;
  try {
    const id = await resolveGuardIdentity(ctx || newGuardContext(), args || {}, false);
    target = id?.target ?? null;
  } catch { return null; }
  if (!target) return null;
  const proc = String(target.processName || "").toLowerCase();
  const cls = String(target.className || "");
  const title = String(target.title || "");
  const hitProc = RED_LINE_PROCESSES.find((p) => proc === p || proc.startsWith(p));
  if (hitProc) {
    return { rule: "never-automate-process", process: proc, target,
      reason: "Process '" + proc + "' is a terminal, credential store, or system tooling; automation is blocked by policy. Set WCU_ALLOW_REDLINES=1 in the host environment to override deliberately." };
  }
  if (RED_LINE_CLASSES.includes(cls)) {
    return { rule: "never-automate-window-class", className: cls, target,
      reason: "Window class '" + cls + "' is blocked by policy." };
  }
  if (cls === "#32770" && /(^Run|运行)/.test(title)) {
    return { rule: "never-automate-run-dialog", title, target, reason: "The Windows Run dialog is blocked by policy." };
  }
  if (/用户账户控制|User Account Control/.test(title)) {
    return { rule: "uac-prompt", title, target, reason: "A UAC elevation prompt is on screen; policy forbids automating it." };
  }
  return null;
}

// element_info is more useful when it also says which actions the element supports.
async function enrichElementInfo(result, request) {
  try {
    const text = textOf(result);
    if (!text) return result;
    const parsed = JSON.parse(text);
    const id = parsed && parsed.element ? parsed.element.id : null;
    if (!id) return result;
    try {
      const actions = await runBackend('element_actions', { elementId: id, processId: parsed.element.processId }, 15000, request);
      if (actions && Array.isArray(actions.availableActions)) parsed.element.secondaryActions = actions.availableActions;
    } catch (error) { parsed.element.secondaryActionsError = String(error.message).slice(0, 160); }
    try {
      const textHit = await runBackend('element_text', { elementId: id, processId: parsed.element.processId, maxChars: 2000 }, 15000, request);
      if (textHit && typeof textHit.text === 'string' && textHit.text.length > 0) {
        parsed.element.text = textHit.text;
        parsed.element.textSource = textHit.source || null;
      } else {
        parsed.element.text = null;
        parsed.element.textNote = 'this control exposes no readable text (ValuePattern/TextPattern/LegacyIAccessible/GetWindowText all empty)';
      }
    } catch (error) { parsed.element.textError = String(error.message).slice(0, 200); }
    return { content: [{ type: 'text', text: safeJson(parsed) }] };
  } catch { return result; }
}

// launch_app accepts a human app name; resolve it to a real launch id first.
async function resolveLaunchTarget(args, request) {
  const named = args && (args.app || args.name);
  if (!named || args.path) return { args: args, refusal: null };
  let resolved = null;
  try { resolved = await runBackend('resolve_app', { name: String(named), max: 5 }, 60000, request); } catch (e) { return { args: args, refusal: refusalPayload('app-index-unavailable', String(e.message).slice(0, 200)) }; }
  if (!resolved || !resolved.match) {
    return {
      args: args,
      refusal: refusalPayload('app-not-found', 'No installed app matched ' + JSON.stringify(String(named)) + '. Call list_apps to see what is installed, or pass an explicit path.', { candidates: resolved ? resolved.candidates : [] })
    };
  }
  const next = Object.assign({}, args, { appName: resolved.match.displayName, appResolution: { exact: resolved.exact, kind: resolved.match.kind, candidates: resolved.candidates } });
  delete next.name;
  // Route by what the index actually returned: packaged apps need the AUMID
  // branch, not a file path (that mismatch made launch-by-name fail 100%).
  const kind = String(resolved.match.kind || 'exe');
  const id = String(resolved.match.id || '');
  delete next.path; delete next.aumid; delete next.url;
  if (kind === 'aumid' || kind === 'appid' || /!/.test(id) && !/[\\/]/.test(id)) next.aumid = id;
  else if (/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(id) && !/^[A-Za-z]:[\\/]/.test(id)) next.url = id;
  else next.path = id;
  return { args: next, refusal: null };
}
async function doctorReport(request) {
  const checks = [];
  const profileDir = path.join(os.homedir(), ".dsh", "profiles", "web");
  const mcpClientPkg = path.join(profileDir, "node_modules", "@deepseek-ai", "dsh-mcp-client", "package.json");
  checks.push({
    name: "mcp-bridge-resolvable",
    ok: existsSync(mcpClientPkg),
    detail: mcpClientPkg,
    fix: existsSync(mcpClientPkg) ? null : "dsh plugin --profile web add @deepseek-ai/dsh-mcp-client@0.2.0-rc.1  (the bundle patch inserts this bridge and resolves it from the profile root)"
  });
  let deps = {};
  try { deps = JSON.parse(readFileSync(path.join(profileDir, "package.json"), "utf8")).dependencies || {}; } catch { /* ignore */ }
  const dep = deps["dsh-computer-use-win"] || null;
  checks.push({ name: "profile-dependency", ok: !!dep, detail: dep, fix: dep ? null : "dsh plugin --profile web add file:<path to the wincu checkout>" });

  try {
    const health = await runBackend("health", {}, 20000, request);
    checks.push({ name: "backend", ok: health?.ok !== false, detail: { mode: health?.mode, powershell: health?.powershell, uiAutomation: health?.uiAutomation, screenshot: health?.screenshot } });
  } catch (e) { checks.push({ name: "backend", ok: false, detail: String(e.message).slice(0, 200), fix: "The PowerShell backend did not answer; it is respawned lazily on the next call." }); }

  try {
    const caps = await runBackend("capabilities", {}, 40000, request);
    checks.push({
      name: "capabilities",
      ok: caps?.ok !== false,
      detail: {
        elevated: caps?.host?.elevated ?? null,
        uiAutomation: caps?.uiAutomation?.available ?? null,
        screenshotTiers: caps?.screenshot ?? null,
        monitors: Array.isArray(caps?.displays?.monitors) ? caps.displays.monitors.length : null,
        ocr: caps?.ocr?.available ?? null,
        redlines: caps?.redLines ?? caps?.approvalRules ?? null,
        browser: caps?.browser ?? null
      }
    });
  } catch (e) { checks.push({ name: "capabilities", ok: false, detail: String(e.message).slice(0, 200) }); }

  try {
    const cur = await runBackend("agent_cursor", { state: true }, 20000, request);
    checks.push({ name: "agent-cursor", ok: true, detail: { helperAlive: cur?.helperAlive ?? false, state: cur?.state ?? null, cmdPath: cur?.cmdPath ?? null } });
  } catch (e) { checks.push({ name: "agent-cursor", ok: true, detail: "not started yet: " + String(e.message).slice(0, 120) }); }

  try {
    const apps = await runBackend('list_apps', { max: 5 }, 60000, request);
    checks.push({ name: 'app-index', ok: apps?.ok !== false, detail: { installed: apps?.count ?? null, sample: (apps?.apps || []).slice(0, 3).map((a) => a.displayName) } });
  } catch (e) { checks.push({ name: 'app-index', ok: false, detail: String(e.message).slice(0, 200) }); }

  const redlineFile = path.join(os.homedir(), ".dsh", "wincu-redlines.json");
  checks.push({ name: "redline-config", ok: true, detail: existsSync(redlineFile) ? redlineFile : "(built-in rules only; optional file absent)" });
  const baselineFile = path.join(os.tmpdir(), "wcu-baselines.json");
  checks.push({ name: "observation-baselines", ok: true, detail: { path: baselineFile, exists: existsSync(baselineFile) } });
  checks.push({ name: "tool-groups", ok: true, detail: enabledToolGroups() || "all groups enabled" });
  checks.push({ name: "recording", ok: true, detail: traceStatus() });
  checks.push({ name: "tools-exposed", ok: true, detail: mergedTools.filter((t) => toolVisible(t.name)).length + " merged tools advertised (" + tools.length + " legacy entry points remain callable)" });

  return { ok: checks.every((c) => c.ok), action: "doctor", checks };
}

// ---------------------------------------------------------------- metrics (P2)
const toolStats = new Map();   // tool -> { count, errors, durations: [] , lastAt }

function recordToolStat(name, elapsedMs, ok) {
  let s = toolStats.get(name);
  if (!s) { s = { count: 0, errors: 0, durations: [], lastAt: null }; toolStats.set(name, s); }
  s.count++;
  if (!ok) s.errors++;
  s.durations.push(elapsedMs);
  if (s.durations.length > 200) s.durations.shift();
  s.lastAt = new Date().toISOString();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function statsReport() {
  const rows = [];
  for (const [tool, s] of toolStats.entries()) {
    const sorted = [...s.durations].sort((a, b) => a - b);
    rows.push({
      tool: tool.replace("windows_computer_use_", ""),
      calls: s.count,
      errors: s.errors,
      errorRate: s.count ? Number((s.errors / s.count).toFixed(3)) : 0,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
      lastAt: s.lastAt
    });
  }
  rows.sort((a, b) => b.calls - a.calls);
  const total = rows.reduce((n, r) => n + r.calls, 0);
  const errors = rows.reduce((n, r) => n + r.errors, 0);
  return { ok: true, action: "stats", since: statsStartedAt, totalCalls: total, totalErrors: errors, tools: rows };
}

const statsStartedAt = new Date().toISOString();

// ------------------------------------------------- observation binding (P1) --
// The Codex runtime forces every coordinate action to name the screenshot it was
// measured from. wincu keeps that optional but makes it enforceable: with
// bindObservation:true an action is refused when the observation is missing,
// belongs to another target, or was invalidated by an earlier input action.
const observationRegistry = new Map();   // id -> { id, targetKey, hwnd, at, invalidated }

function obsTargetKey(args) {
  if (!args) return 'foreground';
  if (args.nativeWindowHandle) return 'hwnd:' + args.nativeWindowHandle;
  if (args.processId) return 'pid:' + args.processId;
  if (args.windowTitle) return 'title:' + String(args.windowTitle).toLowerCase();
  return 'foreground';
}

function textOf(result) {
  if (!result || !Array.isArray(result.content)) return null;
  const part = result.content.find((c) => c && c.type === 'text');
  return part ? part.text : null;
}

function refusalPayload(kind, message, extra) {
  return { content: [{ type: 'text', text: safeJson(Object.assign({ ok: false, refused: kind, inputSent: false, reason: message }, extra || {})) }] };
}

let syntheticObservationSeq = 0;

function rememberObservation(result, args) {
  const text = textOf(result);
  if (!text) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  // Snapshot-style state reads carry no observationId from the engine; mint one
  // so bindObservation and diffAgainst work uniformly on observe AND read.
  if (!parsed.observationId && parsed.ok !== false && (parsed.tree || parsed.screenshot)) {
    syntheticObservationSeq++;
    parsed.observationId = 'obs-r' + syntheticObservationSeq;
    parsed.observationIdNote = 'minted for this state read; valid until an input action runs against the same target';
    result.content = [{ type: 'text', text: safeJson(parsed) }];
  }
  recordBudget(parsed);
  const id = parsed && parsed.observationId;
  if (!id) return null;
  const hwnd = parsed.envelope && parsed.envelope.target ? parsed.envelope.target.hwnd : null;
  const shot = parsed.screenshot || null;
  const rec = {
    id: id, targetKey: obsTargetKey(args), hwnd: hwnd, at: Date.now(), invalidated: null, tree: parsed.tree || null, kind: parsed.action || null,
    // Geometry so a later call can resolve imageX/imageY for ANY action, not
    // just the ones whose engine command happens to support it.
    origin: shot && shot.origin ? shot.origin : (shot && shot.bounds ? { x: shot.bounds.x, y: shot.bounds.y } : null),
    scale: shot && shot.imageScale ? shot.imageScale : 1,
    imageSize: shot && shot.width ? { width: shot.width, height: shot.height } : null,
    cropped: parsed.region ? true : false
  };
  observationRegistry.set(id, rec);
  if (observationRegistry.size > 40) {
    const sorted = [...observationRegistry.values()].sort((a, b) => a.at - b.at);
    if (sorted.length > 0) observationRegistry.delete(sorted[0].id);
  }
  return rec;
}

function invalidateObservationsFor(targetKey, reason) {
  for (const rec of observationRegistry.values()) {
    if (rec.targetKey === targetKey && !rec.invalidated) rec.invalidated = reason;
  }
}

function invalidateAfterInput(name, args) {
  if (!INPUT_TOOL_NAMES.has(name)) return;
  const key = obsTargetKey(args);
  invalidateObservationsFor(key, 'an input action ran against this target afterwards');
  invalidateObservationsFor('foreground', 'an input action ran afterwards');
}

function checkObservationBinding(name, args) {
  if (!args || args.bindObservation !== true) return null;
  const requested = args.observationId || args.screenshotId || null;
  const targetKey = obsTargetKey(args);
  let rec = requested ? observationRegistry.get(requested) : null;
  if (requested && !rec) {
    return refusalPayload('observation-required', 'Observation ' + requested + ' is not known (never observed, or evicted). Observe again and use the returned id.', { requestedObservationId: requested, knownObservations: [...observationRegistry.keys()].slice(-5) });
  }
  if (!rec && args.allowAnyObservation === true) {
    const live = [...observationRegistry.values()].filter((r) => !r.invalidated && (r.targetKey === targetKey || targetKey === 'foreground'));
    rec = live.sort((a, b) => b.at - a.at)[0] || null;
  }
  if (!rec) {
    return refusalPayload('observation-required', 'bindObservation:true needs an observationId (or allowAnyObservation:true to accept the newest one for this target).', { hint: 'Call observe/read first and pass the observationId it returns.' });
  }
  if (!rec) {
    return refusalPayload('observation-required', 'bindObservation:true requires a fresh observation of this target. Call observe (or snapshot) first, then act with its observationId.', { bindObservation: true });
  }
  if (rec.invalidated) {
    return refusalPayload('observation-stale', 'Observation ' + rec.id + ' is no longer valid because ' + rec.invalidated + '. Re-observe before acting.', { observationId: rec.id, invalidatedBy: rec.invalidated });
  }
  if (targetKey !== 'foreground' && rec.targetKey !== targetKey) {
    return refusalPayload('observation-target-mismatch', 'Observation ' + rec.id + ' belongs to ' + rec.targetKey + ' but this call targets ' + targetKey + '.', { observationId: rec.id, observationTarget: rec.targetKey, callTarget: targetKey });
  }
  lastBoundObservationId = rec.id;
  return null;
}

// Screenshot-relative coordinates must work for every point action (the merged
// surface promises it). Resolve them here so the guards and the engine only ever
// see absolute screen coordinates.
function resolveImagePoint(args) {
  if (!args || (args.imageX === undefined && args.imageY === undefined)) return args;
  const id = args.observationId || args.screenshotId || null;
  const rec = id ? observationRegistry.get(id) : null;
  if (!rec) return args;
  if (rec.cropped) return args;   // cropped captures reposition the origin; callers pass x/y then
  const scale = Number(rec.scale) > 0 ? Number(rec.scale) : 1;
  const ox = rec.origin ? Number(rec.origin.x) : 0;
  const oy = rec.origin ? Number(rec.origin.y) : 0;
  const next = Object.assign({}, args);
  if (Number.isFinite(Number(args.imageX))) next.x = Math.round(ox + Number(args.imageX) / scale);
  if (Number.isFinite(Number(args.imageY))) next.y = Math.round(oy + Number(args.imageY) / scale);
  delete next.imageX; delete next.imageY;
  next.resolvedFromImage = { observationId: rec.id, imageX: args.imageX, imageY: args.imageY, scale: scale, origin: { x: ox, y: oy } };
  return next;
}
function withIgnored(result, dropped) {
  if (!dropped || dropped.length === 0) return result;
  try {
    const parsed = JSON.parse(textOf(result));
    parsed.ignoredArgs = dropped;
    return { content: [{ type: 'text', text: safeJson(parsed) }] };
  } catch { return result; }
}

function mergeGuardLog(result, log) {
  const skipped = (log || []).filter((g) => !g.ran);
  if (skipped.length === 0) return result;
  try {
    const parsed = JSON.parse(textOf(result));
    parsed.guardsRun = log.filter((g) => g.ran).map((g) => g.guard);
    parsed.guardsSkipped = skipped;
    return { content: [{ type: 'text', text: safeJson(parsed) }] };
  } catch { return result; }
}

let lastBoundObservationId = null;
// Keyboard input lands in whatever is focused. When the caller names a target
// window, make sure it really owns the focus (optionally activating it first)
// instead of typing into a stranger.
const FOCUS_TOOLS = new Set(['windows_computer_use_type_text', 'windows_computer_use_keypress']);

async function focusGuard(name, args, ctx) {
  if (!FOCUS_TOOLS.has(name)) return null;
  if (!args || args.allowUnfocused === true) return null;
  const target = { windowTitle: args.windowTitle, processId: args.processId, nativeWindowHandle: args.nativeWindowHandle };
  if (!target.windowTitle && !target.processId && !target.nativeWindowHandle) return null;
  let wanted = null;
  let focused = null;
  try {
    wanted = await resolveGuardIdentity(ctx || newGuardContext(), args, true);
    if (!wanted || !wanted.target || !wanted.target.hwnd || wanted.target.resolvedBy !== 'explicit') {
      return refusalPayload('target-not-found', 'No open window matched the target you named, so keyboard focus cannot be checked.', {
        requested: { windowTitle: args.windowTitle || null, processId: args.processId || null, nativeWindowHandle: args.nativeWindowHandle || null },
        hint: 'List windows first and pass an exact title, processId or nativeWindowHandle.'
      });
    }
    if (args.activate === true) {
      // Activate, verify, and refuse with a STRUCTURED payload: letting the engine
      // throw yielded an opaque error, while skipping the check silently typed into
      // whatever modal dialog happened to hold the focus.
      try {
        await runBackend('activate_window', target, 20000, null);
        await new Promise((r) => setTimeout(r, 140));
        ctx.key = null;
        ctx.identity = undefined;
        const after = await resolveGuardIdentity(ctx, args, true);
        const wantHwnd2 = wanted && wanted.target ? wanted.target.hwnd : null;
        const fg2 = after && after.foreground ? after.foreground : null;
        const sameWindow = !!(fg2 && wantHwnd2 && String(fg2.hwnd) === String(wantHwnd2));
        const sameApp = !!(fg2 && wanted && wanted.target && fg2.processId && wanted.target.processId && String(fg2.processId) === String(wanted.target.processId));
        if (!sameWindow && !sameApp) {
          return refusalPayload('activation-failed', 'The target could not be brought to the foreground, so keyboard input was not sent.', {
            targetWindow: { hwnd: wantHwnd2, title: wanted && wanted.target ? wanted.target.title : null, processName: wanted && wanted.target ? wanted.target.processName : null },
            foregroundWindow: fg2 ? { hwnd: fg2.hwnd, title: fg2.title, processName: fg2.processName } : null,
            hint: 'Another window (often a modal dialog) holds the focus. Close it and retry, or pass allowUnfocused:true to type into whatever is focused.'
          });
        }
        return null;
      } catch (error) {
        return refusalPayload('activation-failed', 'Activation threw: ' + String(error && error.message ? error.message : error).slice(0, 160), { hint: 'Retry, or pass allowUnfocused:true to type into the focused window.' });
      }
    }
    focused = { target: wanted ? wanted.foreground : null };
  } catch { return null; }
  const wantedHwnd = wanted && wanted.target ? wanted.target.hwnd : null;
  const focusedHwnd = focused && focused.target ? focused.target.hwnd : null;
  if (!wantedHwnd || !focusedHwnd || wantedHwnd === focusedHwnd) return null;
  // Multi-window apps (WinUI hosts, dialogs, popups) legitimately focus one of
  // their own windows: what matters is that the APP owns the focus, not which
  // of its windows does.
  const wantedPid = wanted.target ? wanted.target.processId : null;
  const focusedPid = focused.target ? focused.target.processId : null;
  if (wantedPid && focusedPid && String(wantedPid) === String(focusedPid)) return null;
  return refusalPayload('not-focused', 'Keyboard input is delivered to the focused window, and the target does not own the focus right now.', {
    targetWindow: { hwnd: wantedHwnd, title: wanted.target.title, processName: wanted.target.processName },
    focusedWindow: { hwnd: focusedHwnd, title: focused.target.title, processName: focused.target.processName },
    hint: 'Pass activate:true to bring the target forward first, or allowUnfocused:true if the current focus is really what you mean.'
  });
}
// One tool call used to resolve the same target window three or four times (red
// line, point ownership, focus). Share one resolution per call; the foreground
// window rides along in the same round trip when a focus check needs it.
function newGuardContext() {
  return { identity: undefined, key: null };
}

async function resolveGuardIdentity(ctx, args, includeForeground) {
  const a = args || {};
  const key = [a.windowTitle || '', a.processId || '', a.nativeWindowHandle || ''].join('|') + '|fg:' + (includeForeground ? 1 : 0);
  if (ctx.identity !== undefined && ctx.key === key) return ctx.identity;
  let value = null;
  try {
    value = await runBackend('target_identity', {
      windowTitle: a.windowTitle, processId: a.processId, nativeWindowHandle: a.nativeWindowHandle,
      includeForeground: includeForeground === true
    }, 15000, null);
  } catch { value = null; }
  ctx.identity = value;
  ctx.key = key;
  return value;
}
// ------------------------------------------------- point ownership pre-check --
const POINT_INPUT_TOOLS = new Set([
  'windows_computer_use_click', 'windows_computer_use_double_click', 'windows_computer_use_scroll',
  'windows_computer_use_drag', 'windows_computer_use_drag_start', 'windows_computer_use_act',
  'windows_computer_use_virtual_click'
]);

async function pointOwnerCheck(name, args, ctx) {
  if (!POINT_INPUT_TOOLS.has(name)) return null;
  if (!args || args.allowAnyWindow === true) return null;
  if (!(args.windowTitle || args.processId || args.nativeWindowHandle)) return null;
  if (args.elementId) return null;
  if (typeof args.x !== 'number' || typeof args.y !== 'number') return null;
  if (args.space && args.space !== 'screen') return null;
  let identity = null;
  let owner = null;
  try {
    identity = await resolveGuardIdentity(ctx || newGuardContext(), args, false);
    if (!identity || !identity.target || !identity.target.hwnd || identity.target.resolvedBy !== 'explicit') {
      return refusalPayload('target-not-found', 'No open window matched the target you named, so that point cannot be checked or clicked.', {
        requested: { windowTitle: args.windowTitle || null, processId: args.processId || null, nativeWindowHandle: args.nativeWindowHandle || null },
        hint: 'List windows first (window {action:"list"} or read {mode:"find"}) and pass an exact title, a processId or a nativeWindowHandle.'
      });
    }
    owner = await runBackend('point_owner', { x: Math.round(args.x), y: Math.round(args.y), targetHwnd: identity.target.hwnd }, 15000, null);
    if (owner && owner.matchesTarget === false && args.activate === true) {
      // The caller asked us to bring the target forward. Activate FIRST and judge
      // the point afterwards; otherwise a legitimate activate-then-click is
      // refused because the target is still behind another window.
      const target = { windowTitle: args.windowTitle, processId: args.processId, nativeWindowHandle: args.nativeWindowHandle };
      await runBackend('activate_window', target, 20000, null);
      await new Promise((r) => setTimeout(r, 180));
      ctx.key = null;
      ctx.identity = undefined;
      identity = await resolveGuardIdentity(ctx, args, false);
      const hwnd2 = identity && identity.target ? identity.target.hwnd : null;
      if (hwnd2) owner = await runBackend('point_owner', { x: Math.round(args.x), y: Math.round(args.y), targetHwnd: hwnd2 }, 15000, null);
    }
  } catch { return null; }
  if (!owner || owner.matchesTarget !== false) return null;
  // A window of the target process is still the target, even if it is not the
  // exact hwnd we resolved.
  const ownerPid = owner.window ? owner.window.processId : null;
  const targetPid = identity.target ? identity.target.processId : null;
  if (ownerPid && targetPid && String(ownerPid) === String(targetPid)) return null;
  return refusalPayload('point-owner-mismatch', 'That point belongs to a different window than the target (input goes to whatever is physically under the point).', {
    point: owner.point,
    expectedWindow: identity && identity.target ? { hwnd: identity.target.hwnd, title: identity.target.title, processName: identity.target.processName } : null,
    actualWindow: owner.window,
    hint: 'Re-observe before clicking: the target may have moved or be covered. Pass allowAnyWindow:true to send input to whatever is under the point.'
  });
}

// ------------------------------------------------------- auto settle (P1) ----
// Codex requires the model to re-observe after every action. wincu does the
// boring half automatically: after a committing input it watches the target's
// pixels until they stop changing and reports how long that took.
const SETTLE_TOOLS = new Set([
  'windows_computer_use_click', 'windows_computer_use_double_click', 'windows_computer_use_type_text',
  'windows_computer_use_keypress', 'windows_computer_use_scroll', 'windows_computer_use_set_value',
  'windows_computer_use_invoke', 'windows_computer_use_secondary_action', 'windows_computer_use_drag_end',
  'windows_computer_use_virtual_click', 'windows_computer_use_act'
]);

async function settleAfterAction(name, args, result) {
  if (!SETTLE_TOOLS.has(name)) return;
  if (args && args.settle === false) return;
  const text = textOf(result);
  if (!text) return;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; }
  if (!parsed || parsed.ok === false) return;
  const target = { windowTitle: args && args.windowTitle, processId: args && args.processId, nativeWindowHandle: args && args.nativeWindowHandle };
  const started = Date.now();
  try {
    const obs = await runBackend('observe', Object.assign({}, target, { returnMode: 'hash', stableMs: 180, stableTimeoutMs: 2000, maxWidth: 480, transient: false }), 20000, null);
    if (obs && obs.ok !== false) {
      parsed.settle = {
        settleMs: typeof obs.settleMs === 'number' ? obs.settleMs : (Date.now() - started),
        stable: obs.stable === undefined ? null : obs.stable,
        hash: obs.screenshot ? obs.screenshot.hash : null,
        note: 'auto-settled after the action: the target pixels were watched until they stopped changing (pass settle:false to skip)'
      };
      result.content = [{ type: 'text', text: safeJson(parsed) }];
    }
  } catch { }
}
// ---------------------------------------------------------------- tracing (M4)
let activeTrace = null;
const cryptoMod = null;

function traceStart(args) {
  if (activeTrace) return { ok: false, error: "A trace is already active.", path: activeTrace.path, steps: activeTrace.steps };
  
  const path_ = args?.path || path.join(os.tmpdir(), "wcu-trace-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jsonl");
  const stream = createWriteStream(path_, { flags: "a" });
  activeTrace = { path: path_, stream, steps: 0, startedAt: new Date().toISOString(), label: args?.label ?? null };
  stream.write(JSON.stringify({ kind: "header", schema: "wcu-trace/1", startedAt: activeTrace.startedAt, label: activeTrace.label, host: os.hostname() }) + "\n");
  return { ok: true, recording: true, path: path_, label: activeTrace.label };
}

function traceStop() {
  if (!activeTrace) return { ok: true, recording: false, note: "No active trace." };
  const t = activeTrace;
  try { t.stream.write(JSON.stringify({ kind: "footer", endedAt: new Date().toISOString(), steps: t.steps }) + "\n"); t.stream.end(); } catch { /* ignore */ }
  activeTrace = null;
  return { ok: true, recording: false, path: t.path, steps: t.steps, startedAt: t.startedAt };
}

function traceStatus() {
  if (!activeTrace) return { ok: true, recording: false };
  return { ok: true, recording: true, path: activeTrace.path, steps: activeTrace.steps, startedAt: activeTrace.startedAt, label: activeTrace.label };
}

function traceAppend(entry) {
  if (!activeTrace) return;
  try { activeTrace.stream.write(JSON.stringify(entry) + "\n"); activeTrace.steps++; } catch { /* ignore */ }
}

function digestResult(result) {
  try {
    const text = (result?.content || []).find((c) => c.type === "text")?.text;
    if (!text) return null;
    const j = JSON.parse(text);
    return {
      ok: j.ok ?? null,
      action: j.action ?? null,
      target: j.envelope?.target ?? null,
      evidence: j.evidence ?? null,
      changed: j.changed ?? null,
      passed: j.passed ?? null
    };
  } catch { return null; }
}

function substituteVars(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (m, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => substituteVars(v, vars));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteVars(v, vars);
    return out;
  }
  return value;
}

async function elementFingerprint(args) {
  if (!args || !args.elementId) return null;
  try {
    const info = await runBackend("element_info", {
      elementId: args.elementId, windowTitle: args.windowTitle, processId: args.processId, nativeWindowHandle: args.nativeWindowHandle
    }, 15000, null);
    const el = info?.element ?? null;
    if (!el) return null;
    return { name: el.name, automationId: el.automationId, className: el.className, controlType: el.controlType, boundingBox: el.boundingBox, runtimeId: el.runtimeId ?? null };
  } catch { return null; }
}

async function relocateElementArgs(step) {
  const args = { ...(step.args || {}) };
  const fp = step.element;
  if (!fp || !args.elementId) return { args, note: null };
  try {
    const info = await runBackend("element_info", {
      elementId: args.elementId, windowTitle: args.windowTitle, processId: args.processId, nativeWindowHandle: args.nativeWindowHandle
    }, 15000, null);
    if (info?.element) return { args, note: "recorded element id still resolves" };
  } catch { /* relocate below */ }
  const query = fp.automationId || fp.name;
  if (!query) return { args, note: "element is gone and the fingerprint carries no name/automationId to search for" };
  try {
    const found = await runBackend("find", {
      query, controlType: fp.controlType || "", windowTitle: args.windowTitle, processId: args.processId, nativeWindowHandle: args.nativeWindowHandle, maxResults: 5
    }, 20000, null);
    const list = found?.results || [];
    const hit = list.find((r) => (fp.automationId ? r.automationId === fp.automationId : r.name === fp.name)) || list[0];
    if (hit?.id) { args.elementId = hit.id; return { args, note: "element relocated by " + (fp.automationId ? "automationId" : "name") + " -> " + hit.id }; }
  } catch { /* fall through */ }
  return { args, note: "element relocation failed; the recorded id is used as-is and may report stale" };
}

async function traceReplay(args, request) {
  const path_ = args?.path || (activeTrace ? activeTrace.path : null);
  if (!path_) return { ok: false, error: "No trace path given and no trace was started in this session." };
  let lines;
  try { lines = readFileSync(path_, "utf8").split(/\r?\n/).filter(Boolean); } catch (e) { return { ok: false, error: "Cannot read trace: " + e.message }; }
  const steps = [];
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.kind === "header" || rec.kind === "footer" || rec.kind === "meta") continue;
    if (!rec.tool) continue;
    if (/record_(start|stop|status)$/.test(rec.tool)) continue;
    if (args?.filter && !rec.tool.includes(args.filter)) continue;
    steps.push(rec);
    if (steps.length >= (args?.maxSteps ?? 100)) break;
  }
  const vars = args?.vars || {};
  const from = Math.max(1, Number(args?.fromStep || 1));
  const to = Math.min(steps.length, Number(args?.toStep || steps.length));
  const window_ = steps.slice(from - 1, to);
  if (args?.dryRun) {
    return { ok: true, dryRun: true, path: path_, fromStep: from, toStep: to, stepCount: window_.length, steps: window_.map((s, i) => ({ index: from + i, tool: s.tool, args: substituteVars(s.args, vars), element: s.element ?? null })) };
  }
  const results = [];
  for (const [i, step] of window_.entries()) {
    const sub = substituteVars(step.args || {}, vars);
    const reloc = await relocateElementArgs({ ...step, args: sub });
    const t0 = Date.now();
    let entry;
    try {
      const out = await dispatchTool(step.tool, reloc.args, request);
      const digest = digestResult(out);
      entry = { index: from + i, tool: step.tool, ok: true, elapsedMs: Date.now() - t0, relocation: reloc.note, result: digest };
      const recChanged = step.result?.evidence?.changed ?? null;
      const nowChanged = digest?.evidence?.changed ?? null;
      const recPassed = step.result?.passed ?? null;
      const nowPassed = digest?.passed ?? null;
      if (recChanged === true && nowChanged === false) { entry.ok = false; entry.outcomeDrift = "recording reported a pixel change, this replay reported none"; }
      if (recPassed === true && nowPassed === false) { entry.ok = false; entry.outcomeDrift = "recording satisfied its expectation, this replay did not"; }
    } catch (e) {
      entry = { index: from + i, tool: step.tool, ok: false, elapsedMs: Date.now() - t0, relocation: reloc.note, error: String(e.message).slice(0, 300) };
    }
    results.push(entry);
    if (!entry.ok && !args?.continueOnError) return { ok: false, path: path_, failedAt: entry.index, stepCount: results.length, results };
  }
  return { ok: results.every((r) => r.ok), path: path_, fromStep: from, toStep: to, stepCount: results.length, results };
}

// Window targets are re-resolved hwnd -> pid -> title so a trace survives restarts.
function relocateArgs(step) {
  const args = { ...(step.args || {}) };
  const target = step.result?.target || step.target || null;
  const note = [];
  if (target) {
    if (args.nativeWindowHandle && args.nativeWindowHandle !== target.hwnd) {
      if (target.processId) { args.processId = target.processId; delete args.nativeWindowHandle; note.push("hwnd drifted -> used pid " + target.processId); }
      else if (target.title) { args.windowTitle = target.title; delete args.nativeWindowHandle; note.push("hwnd gone -> used title"); }
    }
  }
  return { args, note: note.join("; ") || null };
}

async function callTool(name, args, request) {
  const statStart = Date.now();
  const rawResult = await callToolInner(name, args, request, statStart).catch((e) => {
    recordToolStat(name, Date.now() - statStart, false);
    throw e;
  });
  return rawResult;
}

async function callToolInner(name, args, request, statStart) {
  // Merged entry points route to the engine action they stand for before any
  // policy check runs, so group gating, approvals, red lines and tracing all
  // keep operating on the legacy name.
  const requestedName = name;
  const routed = routeToLegacy(name, args);
  if (routed && routed.refusal) return routed.refusal;
  name = routed.tool;
  // Validate against the schema the caller was shown (the merged entry), not the
  // engine action it routes to - otherwise merged-only parameters get dropped.
  const hygiene = filterArgsForAction(requestedName, routed.args);
  args = hygiene.args;
  if (!toolVisible(name)) {
    const groups = enabledToolGroups() || [];
    return { content: [{ type: "text", text: safeJson({ ok: false, action: name.replace("windows_computer_use_", ""), disabled: true, reason: "This tool's group is disabled by WCU_TOOL_GROUPS.", enabledGroups: groups, hint: "Set WCU_TOOL_GROUPS in the host environment to include it, e.g. WCU_TOOL_GROUPS=core,cursor,vision,record,dev." }) }] };
  }
  const rule = APPROVAL_RULES.find((r) => r.tool === name);
  if (rule && rule.when(args) && args?.approve !== true) {
    const payload = {
      ok: false,
      action: name.replace("windows_computer_use_", ""),
      refused: "approval-required",
      inputSent: false,
      reason: rule.why,
      hint: "Re-issue the exact call with approve:true once you are sure the target has no unsaved state."
    };
    if (activeTrace) traceAppend({ kind: "step", ts: new Date().toISOString(), tool: name, args, refused: "approval-required", elapsedMs: 0 });
    return { content: [{ type: "text", text: safeJson(payload) }] };
  }
  const guardCtx = newGuardContext();
  const refusal = await redLineRefusal(name, args, guardCtx).catch(() => null);
  if (refusal) {
    const payload = { ok: false, action: name.replace("windows_computer_use_", ""), refused: "red-line", inputSent: false, detail: refusal };
    if (activeTrace) traceAppend({ kind: "step", ts: new Date().toISOString(), tool: name, args, refused: "red-line", elapsedMs: 0 });
    return { content: [{ type: "text", text: safeJson(payload) }] };
  }
  args = resolveImagePoint(args);
  const guardLog = [];
  const skipGuards = !!(args && args.unsafe === 'skip-guards');
  const runGuard = async (guardName, fn) => {
    if (skipGuards) { guardLog.push({ guard: guardName, ran: false, reason: 'unsafe:skip-guards' }); return null; }
    try {
      const out = await fn();
      guardLog.push({ guard: guardName, ran: true });
      return out;
    } catch (error) {
      const message = String(error && error.message ? error.message : error).slice(0, 160);
      guardLog.push({ guard: guardName, ran: false, reason: message });
      return refusalPayload('guard-unavailable', 'The ' + guardName + ' safety check could not run (' + message + '). Refusing instead of acting blind.', { guard: guardName, hint: 'Retry once; if it keeps failing, pass unsafe:"skip-guards" to run WITHOUT safety checks (explicitly).' });
    }
  };
  const focusRefusal = await runGuard('focus', () => focusGuard(name, args, guardCtx));
  if (focusRefusal) return withIgnored(focusRefusal, hygiene.dropped);
  const pointRefusal = await runGuard('point-owner', () => pointOwnerCheck(name, args, guardCtx));
  if (pointRefusal) return withIgnored(pointRefusal, hygiene.dropped);
  const bindingRefusal = checkObservationBinding(name, args);
  if (bindingRefusal) return withIgnored(bindingRefusal, hygiene.dropped);
  const started = Date.now();
  const fingerprint = activeTrace ? await elementFingerprint(args).catch(() => null) : null;
  let result;
  try {
    result = await dispatchTool(name, args, request);
  } catch (error) {
    if (activeTrace) traceAppend({ kind: "step", ts: new Date().toISOString(), tool: name, args, ok: false, elapsedMs: Date.now() - started, error: String(error.message).slice(0, 300) });
    throw error;
  }
  if (args && args.diffAgainst) result = applyTreeDiff(result, args);
  if (lastBoundObservationId) {
    try {
      const parsed = JSON.parse(textOf(result));
      parsed.boundObservationId = lastBoundObservationId;
      result = { content: [{ type: 'text', text: safeJson(parsed) }] };
    } catch { }
    lastBoundObservationId = null;
  }
  result = mergeGuardLog(result, guardLog);
  if (hygiene.dropped.length > 0) result = noteIgnoredArgs(result, requestedName, hygiene.dropped);
  rememberObservation(result, args);
  invalidateAfterInput(name, args);
  await settleAfterAction(name, args, result);
  if (activeTrace) {
    traceAppend({ kind: "step", ts: new Date().toISOString(), tool: name, args, element: fingerprint, ok: true, elapsedMs: Date.now() - started, result: digestResult(result) });
  }
  const digest = digestResult(result);
  recordToolStat(name, Date.now() - statStart, digest?.ok !== false);
  return result;
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "notifications/initialized") return null;
  if (method === "notifications/cancelled") {
    const request = pendingToolCalls.get(params?.requestId);
    // Only this MCP process's own request and worker may be affected.
    if (request) cancelBackendRequest(request);
    return null;
  }
  if (method === "initialize") {
    scheduleWarmup(0);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: {
          name: "windows-computer-use",
          version: SERVER_VERSION
        }
      }
    };
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: mergedTools.filter((t) => toolVisible(t.name)) } };
  }
  if (method === "tools/call") {
    const request = { proc: null };
    pendingToolCalls.set(id, request);
    try {
      const result = await callTool(params?.name, params?.arguments || {}, request);
      if (request.cancelled) return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "COMPUTER_USE_CANCELLED_AFTER_CURRENT_ACTION" }] } };
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
        }
      };
    } finally {
      if (pendingToolCalls.get(id) === request) pendingToolCalls.delete(id);
    }
  }
  if (method === "resources/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        resources: wikiResources.map(({ uri, name, mimeType }) => ({ uri, name, mimeType }))
      }
    };
  }
  if (method === "resources/read") {
    const resource = wikiResources.find((item) => item.uri === params?.uri);
    if (!resource) {
      return rpcError(id, -32602, `Unknown resource: ${params?.uri}`);
    }
    const text = await readFile(resource.file, "utf8");
    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }]
      }
    };
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

let framingMode = "line";
function send(message) {
  if (!message) return;
  const payload = JSON.stringify(message);
  if (framingMode === "headers") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  } else {
    process.stdout.write(`${payload}\n`);
  }
}

let buffer = Buffer.alloc(0);
function ingest(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length > 0) {
    const asText = buffer.toString("utf8");
    if (asText.startsWith("Content-Length:")) {
      framingMode = "headers";
      const headerEnd = asText.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = asText.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error("Invalid MCP Content-Length header");
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      dispatch(JSON.parse(body));
      continue;
    }
    const newline = asText.indexOf("\n");
    if (newline === -1) return;
    const line = asText.slice(0, newline).trim();
    buffer = buffer.subarray(Buffer.byteLength(asText.slice(0, newline + 1), "utf8"));
    if (line) dispatch(JSON.parse(line));
  }
}

function dispatch(message) {
  pendingRequests += 1;
  Promise.resolve(handleRequest(message))
    .then(send)
    .catch((error) => {
      const id = message && Object.hasOwn(message, "id") ? message.id : null;
      send(rpcError(id, -32603, error instanceof Error ? error.message : String(error)));
    })
    .finally(() => {
      pendingRequests -= 1;
      maybeExitAfterStdinEnd();
    });
}

async function selfTest() {
  const health = await runBackend("health", {});
  const snapshot = await runBackend(
    "snapshot",
    { scope: "active_window", includeScreenshot: true, maxDepth: 0, maxNodes: 1 },
    45000
  );
  const toolsOk = tools.length >= 10;
  const screenshotBytes = snapshot?.screenshot?.base64 ? Buffer.byteLength(snapshot.screenshot.base64, "base64") : 0;
  const screenshotOk = screenshotBytes > 1000 && snapshot?.screenshot?.mimeType === "image/png";
  return {
    ok: Boolean(health.ok && toolsOk && screenshotOk && snapshot?.tree),
    server: { name: "windows-computer-use", version: SERVER_VERSION },
    pluginRoot,
    backendPath,
    tools: tools.length,
    backend: health,
    screenshot: {
      ok: screenshotOk,
      mimeType: snapshot?.screenshot?.mimeType,
      bytes: screenshotBytes,
      bounds: snapshot?.screenshot?.bounds,
      path: snapshot?.screenshot?.path
    }
  };
}

if (process.argv.includes("--self-test")) {
  selfTest()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      killBackend();
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      killBackend();
      process.exit(1);
    });
} else if (process.argv[2] === "--backend") {
  const action = process.argv[3] || "health";
  parseBackendCliArgs()
    .then((args) => runBackend(action, args))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      killBackend();
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      killBackend();
      process.exit(1);
    });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on("exit", () => { isShuttingDown = true; killBackend(); });
  process.stdin.on("data", (chunk) => {
    try {
      ingest(chunk);
    } catch (error) {
      send(rpcError(null, -32700, error instanceof Error ? error.message : String(error)));
    }
  });
  process.stdin.on("end", () => {
    isShuttingDown = true;
    stdinEnded = true;
    maybeExitAfterStdinEnd();
  });
  process.stderr.write(`windows-computer-use MCP server ${SERVER_VERSION} ready\n`);
}

let pendingRequests = 0;
let stdinEnded = false;

function maybeExitAfterStdinEnd() {
  if (stdinEnded && pendingRequests === 0) {
    process.exit(0);
  }
}

async function parseBackendCliArgs() {
  const rawArg = process.argv.slice(4).join(" ").trim();
  if (rawArg) {
    return JSON.parse(rawArg);
  }
  if (process.stdin.isTTY) {
    return {};
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const rawStdin = Buffer.concat(chunks).toString("utf8").trim();
  return rawStdin ? JSON.parse(rawStdin) : {};
}
