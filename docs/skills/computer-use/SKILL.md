---
name: computer-use
description: Drive Windows apps through the wincu (windows_computer_use) tools.
---

# Computer Use (wincu)

16 entry points, one per intent. Pick the mode instead of hunting for a tool name.

| Tool | What it is for |
| --- | --- |
| `read` | mode `window` (screenshot ± tree) · `tree` · `find` (search controls) · `element` (one control, by id or point) · `query` (filter a tree you already have) · `ocr` (canvas-like apps) |
| `mouse` | action `click` · `double_click` · `move` · `scroll` · `drag` (phase `path` \| `start` \| `step` \| `end`) |
| `keyboard` | action `type` · `press` (chord) · `focus` |
| `act` | do one thing **and prove it**: delivery ladder + `expect` predicates |
| `element` | action `actions` · `invoke` · `set_value` · `secondary` (Expand/Collapse/Scroll/Raise/Select/Default) |
| `window` | action `list` · `activate` · `close` · `move` · `transient` (owned menus/dialogs) · `identity` |
| `app` | action `list` · `resolve` · `launch` (by name!) · `kill` |
| `observe` | budgeted look: region/clientArea, inline/file/hash, diffOnly, stableMs, token estimate, `observationId` |
| `verify` | mode `predicates` (poll until all hold) · `point` (who owns this screen point?) |
| `cursor` | virtual overlay arrow: show/hide/move/click/state/quit (never moves the real pointer) |
| `record` | start/stop/status/replay a JSONL trace |
| `describe` | OCR-first vision fallback (auto invert/contrast/upscale, optional VLM) |
| `status` | `capabilities` · `doctor` · `stats` |
| `clipboard`, `wait`, `health` | exactly what they say |

## The loop

1. **Look.** `window {action:"list"}` or `read {mode:"find", query:"Save"}` to pick a target, then `observe` (cheap: `returnMode:"hash"` or `region:"clientArea"`). Keep the `observationId` — it is the receipt for what you are about to do.
2. **Act once.** Prefer `act` (it escalates semantic → background → foreground and verifies), then `element` for named accessibility actions, then `mouse`/`keyboard`. Coordinates last.
3. **Verify.** `verify` or another `observe`. Delivered input is not an outcome.

## Rules that save a turn

- Coordinates are **screen pixels** by default; inside a window say `space:"window"` or `space:"client"` (client = title bar excluded). The result echoes all three.
- Clicking a point you measured **in a screenshot**: use `mouse {action:"click", imageX, imageY, observationId}`; never hand-convert.
- `bindObservation:true` makes the engine enforce "observe before you act": stale or mismatched observations are refused (`observation-stale`), not clicked.
- `homing` defaults to `strict`: if the window moved since it was observed you get `window_moved`. Re-observe, or pass `homing:"auto"` deliberately.
- Coordinate input is pre-checked for ownership → `point-owner-mismatch` when the point belongs to another window; `allowAnyWindow:true` overrides.
- Committing input auto-settles; the result carries `settle.settleMs`. `settle:false` turns that off.
- Menus/modals owned by the target arrive inside the same `observe` (`transientWindows`); `window {action:"transient"}` lists them alone.

## Recovery playbook

- **Window binding broke / stale**: `window {action:"list"}` → `window {action:"identity"}` → re-observe. Do not reuse old coordinates or element ids.
- **Nothing happened**: `verify` with an explicit expectation. If it fails, re-observe; escalate with `act {allowForeground:true}` only because the expectation says it is still missing.
- **`point-owner-mismatch`**: the target is covered or moved → `window {action:"activate"}` then re-observe.
- **A modal is blocking**: `window {action:"transient"}` (it is usually a separate owned window).
- **`window_moved`**: re-observe; `homing:"auto"` only if you truly cannot.
- **Wedged**: `status {detail:"doctor"}` then `status {detail:"stats"}`.

## Safety (enforced in code)

- Terminal/console hosts, Run dialog, UAC prompts, credential stores, security tooling → **refused**, no input sent (`refused:"red-line"`). Operators can extend the list in `%USERPROFILE%\.dsh\wincu-redlines.json`.
- `app {action:"kill", mode:"kill"}`, `window {action:"close"}` and system key chords need `approve:true`.
- A refusal is an answer, not an obstacle: do not retry it through another tool.
