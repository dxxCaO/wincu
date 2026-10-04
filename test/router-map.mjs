import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static contract for the merged tool surface (v0.3.3+):
//  * exactly MERGED_COUNT entries are advertised,
//  * every advertised entry has a router case,
//  * every tool definition is either advertised or reachable through a route,
//  * every router target exists as a definition,
//  * argument hygiene validates against the ADVERTISED schema first.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'mcp', 'server.mjs'), 'utf8');

const MERGED_COUNT = Number(process.env.WCU_MERGED_COUNT || 16);

const mergedStart = src.indexOf('const mergedTools = [');
assert.ok(mergedStart > 0, 'mergedTools array not found');
const mergedEnd = src.indexOf('\n];', mergedStart);
const mergedList = [...src.slice(mergedStart, mergedEnd).matchAll(/name: "(windows_computer_use_[a-z_0-9]+)"/g)].map((m) => m[1]);
const merged = new Set(mergedList);

const routerStart = src.indexOf('function routeToLegacy(name, args) {');
assert.ok(routerStart > 0, 'routeToLegacy not found');
const routerEnd = src.indexOf('\n}\n', routerStart);
const router = src.slice(routerStart, routerEnd);
const cases = new Set([...router.matchAll(/case "(windows_computer_use_[a-z_0-9]+)":/g)].map((m) => m[1]));
const targets = new Set([...router.matchAll(/"(windows_computer_use_[a-z_0-9]+)"/g)].map((m) => m[1]));
const defined = new Set([...src.matchAll(/name: "(windows_computer_use_[a-z_0-9]+)"/g)].map((m) => m[1]));

assert.equal(merged.size, MERGED_COUNT, 'advertised entry count changed: ' + merged.size);
for (const name of mergedList) assert.ok(cases.has(name), 'advertised entry without a router case: ' + name);

const orphans = [...defined].filter((n) => !merged.has(n) && !targets.has(n));
assert.deepEqual(orphans, [], 'definitions that are neither advertised nor reachable: ' + orphans.join(', '));

const missing = [...targets].filter((n) => !defined.has(n));
assert.deepEqual(missing, [], 'router targets without a definition: ' + missing.join(', '));

assert.ok(
  src.includes('mergedTools.find((t) => t.name === toolName) || tools.find((t) => t.name === toolName)'),
  'argument hygiene must validate against the advertised (merged) schema first'
);

console.log('PASS router map: ' + merged.size + ' advertised, ' + targets.size + ' routed targets, ' + defined.size + ' definitions, 0 orphans');
