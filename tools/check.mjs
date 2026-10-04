// tools/check.mjs - one command that guards the invariants this fork keeps
// breaking by hand: JS syntax, the Windows PowerShell BOM/parse contract, the
// merged tool-surface routing map, and the per-request prompt budget.
//
// usage: node tools/check.mjs        (WCU_TOOL_BUDGET_CHARS to override 20000)
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let passed = 0;

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS ' + name);
  } catch (error) {
    failures.push(name + ': ' + (error && error.message ? error.message : String(error)));
    console.log('FAIL ' + name + ' :: ' + (error && error.message ? error.message : String(error)));
  }
}

await step('js-syntax', () => {
  const files = ['mcp/server.mjs', 'test/router-map.mjs', 'test/mcp-test.mjs', 'tools/check.mjs', 'tools/sync-upstream.mjs'];
  for (const f of files) execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
});

await step('powershell-contract', () => {
  const files = ['scripts/windows-uia.ps1', 'scripts/windows-uia-ext.ps1', 'scripts/agent-cursor.ps1'];
  for (const f of files) {
    const buf = readFileSync(path.join(root, f));
    if (!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)) throw new Error(f + ' lost its UTF-8 BOM');
  }
  const script = files
    .map((f) => "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + path.join(root, f).replace(/'/g, "''") + "',[ref]$null,[ref]$e); if($e.Count){ throw ('" + f + ": ' + $e[0].Message) }")
    .join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'pipe', windowsHide: true });
});

await step('router-map', () => {
  execFileSync(process.execPath, [path.join(root, 'test', 'router-map.mjs')], { stdio: 'pipe' });
});

await step('tool-budget', async () => {
  const budget = Number(process.env.WCU_TOOL_BUDGET_CHARS || 20000);
  const server = spawn(process.execPath, [path.join(root, 'mcp', 'server.mjs')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  server.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }
    }
  });
  const call = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout waiting for ' + method)); } }, 30000);
    });
  };
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
    const list = await call('tools/list', {});
    const chars = list.tools.reduce((sum, t) => sum + (t.description || '').length + JSON.stringify(t.inputSchema || {}).length, 0);
    if (chars > budget) throw new Error('advertised tool surface is ' + chars + ' chars, budget is ' + budget + ' - trim descriptions or merge entries instead of raising the budget');
    console.log('      ' + list.tools.length + ' tools, ' + chars + ' chars (~' + Math.round(chars / 4) + ' tokens), budget ' + budget);
  } finally {
    server.kill();
  }
});

console.log('');
console.log(passed + ' passed, ' + failures.length + ' failed');
if (failures.length > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
