#!/usr/bin/env node
/**
 * Summarises `records.jsonl` from `run-corpus.mjs` into `report.md`.
 *
 *   node lib/fcstd-import/corpus/summarize.mjs --records <file> --out <dir> [--files <list>]
 *
 * `--files` restricts the summary to the paths of a list, for like-for-like
 * comparison with an earlier sample.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const only = arg('files', '') ? new Set(readFileSync(arg('files', ''), 'utf8').split('\n').filter(Boolean)) : undefined;
const records = readFileSync(arg('records', ''), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => !only || only.has(r.file));

const count = (rows, key) => {
  const c = new Map();
  for (const r of rows) for (const k of key(r)) c.set(k, (c.get(k) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
};

const withBodies = records.filter((r) => r.bodies.some((b) => b.verdict !== 'noOracle'));
const single = withBodies.filter((r) => r.bodies.length === 1);
const fileMatch = (r) => r.bodies.filter((b) => b.verdict !== 'noOracle').every((b) => b.verdict === 'match');
const bodies = withBodies.flatMap((r) => r.bodies.filter((b) => b.verdict !== 'noOracle'));
const pct = (a, b) => (b === 0 ? '0.0' : ((a * 100) / b).toFixed(1));

const out = [];
const w = (s = '') => out.push(s);
w('# FreeCAD corpus measurement');
w();
w(`Files: ${records.length}. Errors: ${records.filter((r) => r.error).length} (hangs ${records.filter((r) => r.error === 'hang').length}, crashes ${records.filter((r) => r.error === 'crash').length}).`);
w();
w(`Single-Body files with a stored shape: ${single.length}, match ${single.filter(fileMatch).length} (${pct(single.filter(fileMatch).length, single.length)}%).`);
w(`Files with Bodies: ${withBodies.length}, every Body matches in ${withBodies.filter(fileMatch).length} (${pct(withBodies.filter(fileMatch).length, withBodies.length)}%).`);
const stored = (r) => r.notes.some((n) => n.includes('stored'));
const rebuilt = withBodies.filter((r) => fileMatch(r) && !stored(r));
w(`Rebuilt with no stored shape standing in: ${rebuilt.length} of ${withBodies.length} files (${pct(rebuilt.length, withBodies.length)}%).`);
const noBody = records.filter((r) => r.bodies.length === 0 && !r.error);
w(`Files with no Body: ${noBody.length}, of which ${noBody.filter((r) => (r.solids ?? 0) > 0).length} come in with solids.`);
const sum = (key) => records.reduce((n, r) => n + (r.expressions?.[key] ?? 0), 0);
w(`Expressions: ${sum('carried')} came in as definitions, ${sum('dropped')} stayed numbers.`);
w(`Bodies: ${bodies.length}, match ${bodies.filter((b) => b.verdict === 'match').length} (${pct(bodies.filter((b) => b.verdict === 'match').length, bodies.length)}%).`);
w();
w('## Body verdicts');
w();
for (const [k, n] of count(bodies, (b) => [b.verdict])) w(`- ${k}: ${n}`);
w();
const failing = withBodies.filter((r) => !fileMatch(r));
w('## Why files fail (each file counted once per reason)');
w();
for (const [k, n] of count(failing, (r) => [...new Set([...r.notes.map((m) => `note: ${m}`), ...r.pauses.map((m) => `pause: ${m}`), ...(r.error ? [`error: ${r.error.slice(0, 100)}`] : [])])]).slice(0, 60)) w(`- ${n}: ${k}`);
w();
w('## Failing files with no note, pause or error');
w();
const silent = failing.filter((r) => r.notes.length === 0 && r.pauses.length === 0 && !r.error);
w(`${silent.length} files.`);
for (const r of silent.slice(0, 30)) w(`- ${r.file.replace(/.*fcstd-corpus./, '')}: ${r.bodies.filter((b) => b.verdict !== 'match').map((b) => `${b.label} ${b.verdict} ${b.got ?? ''} / ${b.want ?? ''}`).join('; ')}`);
w();
w('## Object types in failing files, by files');
w();
for (const [k, n] of count(failing, (r) => Object.keys(r.types)).filter(([k]) => k.startsWith('PartDesign::') || k.startsWith('Sketcher::')).slice(0, 40)) w(`- ${n}: ${k}`);
w();
writeFileSync(join(arg('out', '.'), only ? 'report-sample.md' : 'report.md'), `${out.join('\n')}\n`);
process.stdout.write(`${out.slice(0, 8).join('\n')}\n`);
