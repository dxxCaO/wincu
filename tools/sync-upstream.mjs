// tools/sync-upstream.mjs - rebase this fork onto a newer upstream release.
//
// The fork keeps every change in one of two shapes:
//   * new files      (scripts/windows-uia-ext.ps1, scripts/agent-cursor.ps1, tools/, docs/)
//   * anchored hunks inside scripts/windows-uia.ps1 and mcp/server.mjs
// This script re-applies the anchored hunks to a fresh upstream checkout and
// reports every hunk it could not place automatically, so an upgrade is a
// review of a short list instead of a manual diff.
//
// usage: node tools/sync-upstream.mjs <upstream-checkout> [--write]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";

const upstreamRoot = process.argv[2];
const write = process.argv.includes("--write");
if (!upstreamRoot) { console.error("usage: node tools/sync-upstream.mjs <upstream-checkout> [--write]"); process.exit(2); }
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const forkRoot = path.resolve(here, "..");

const HUNKS = [
  {
    file: "scripts/windows-uia.ps1",
    name: "extension layer hook",
    present: (t) => t.includes("windows-uia-ext.ps1"),
    apply: (t) => t.replace(
      /(\$script:WcuExtPath = Join-Path \$PSScriptRoot "windows-uia-ext\.ps1"\r?\nif \(Test-Path \$script:WcuExtPath\) \{ \. \$script:WcuExtPath \}\r?\n)/,
      "$1" + readExtensionBlock())
  },
  {
    file: "scripts/windows-uia.ps1",
    name: "Invoke-Action fallback to the extension dispatch",
    present: (t) => t.includes("Invoke-ExtAction -Action $Action"),
    apply: (t) => t.replace(/(\n\s*default\s*\{)(\s*\r?\n\s*\}\s*\r?\n\})/, "$1\r\n      if (Get-Command Invoke-ExtAction -ErrorAction SilentlyContinue) { return (Invoke-ExtAction -Action $Action -InputObject $inputObject) }\r\n      throw \"Unknown action '$Action'.\"$2")
  },
  {
    file: "scripts/windows-uia.ps1",
    name: "result envelope on the persistent/one-shot entry points",
    present: (t) => t.includes("Add-ResultEnvelope -Result $result"),
    apply: (t) => t
  },
  {
    file: "scripts/windows-uia.ps1",
    name: "coordinate spaces + strict homing (Get-PointFromArgs / Home-Point)",
    present: (t) => t.includes("Resolve-WcuPointSpace") && t.includes("window_moved:"),
    apply: (t) => t
  },
  {
    file: "mcp/server.mjs",
    name: "extension tools (capabilities .. describe)",
    present: (t) => t.includes("windows_computer_use_virtual_click"),
    apply: (t) => t
  },
  {
    file: "mcp/server.mjs",
    name: "compact merged surface + router (16 entries)",
    present: (t) => t.includes("function routeToLegacy") && t.includes("const mergedTools = ["),
    apply: (t) => t
  },
  {
    file: "mcp/server.mjs",
    name: "policy layer (approvals, red lines, binding, point/focus guards, settle)",
    present: (t) => t.includes("APPROVAL_RULES") && t.includes("checkObservationBinding"),
    apply: (t) => t
  },
  {
    file: "mcp/server.mjs",
    name: "recording, replay, metrics and budget",
    present: (t) => t.includes("function traceReplay") && t.includes("function statsReport"),
    apply: (t) => t
  }
];

function readExtensionBlock() {
  const p = path.join(forkRoot, "scripts", "windows-uia.ps1");
  const t = readFileSync(p, "utf8");
  const m = t.match(/(# The extension layer is optional:[\s\S]*?\n\}\n)/);
  return m ? m[1] : "";
}

let problems = 0;
for (const hunk of HUNKS) {
  const target = path.join(upstreamRoot, hunk.file);
  if (!existsSync(target)) { console.log("MISSING FILE  " + hunk.file); problems++; continue; }
  const text = readFileSync(target, "utf8");
  if (hunk.present(text)) { console.log("already       " + hunk.file + " :: " + hunk.name); continue; }
  const applied = hunk.apply(text);
  if (applied === text) { console.log("MANUAL        " + hunk.file + " :: " + hunk.name + "  (anchor not found - port it by hand)"); problems++; continue; }
  console.log("applied       " + hunk.file + " :: " + hunk.name);
  if (write) {
    copyFileSync(target, target + ".pre-sync");
    writeFileSync(target, applied, "utf8");
  }
}
console.log("");
console.log(write ? "Files written (backups kept as *.pre-sync)." : "Dry run: pass --write to modify the upstream checkout.");
console.log("Files this fork adds on top of upstream: scripts/windows-uia-ext.ps1, scripts/agent-cursor.ps1, tools/, docs/fork-delta.md");
console.log(problems ? problems + " hunk(s) need manual attention." : "All hunks are in place.");
