#!/usr/bin/env node
/**
 * Runs the import measurement over a directory of real FreeCAD files.
 *
 *   node lib/fcstd-import/corpus/run-corpus.mjs --corpus <dir> --out <dir>
 *        [--jobs 6] [--timeout 180] [--only <substring>] [--list <file>]
 *
 * Files go in small batches, one process each. A kernel call runs
 * synchronously and cannot be interrupted from inside, so a hang or a crash is
 * handled here: the batch is killed, that one file is recorded as such, and
 * the rest of the batch goes back in the queue.
 *
 * Writes <out>/records.jsonl and <out>/report.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const corpus = resolve(arg('corpus', '.'));
const out = resolve(arg('out', ''));
const jobs = Number(arg('jobs', '6'));
const timeoutSec = Number(arg('timeout', '180'));
const only = arg('only', '');
const listFile = arg('list', '');
const BATCH = 20;

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(p));
    else if (/\.fcstd$/i.test(entry.name)) found.push(p);
  }
  return found;
}

let files;
if (listFile) files = readFileSync(listFile, 'utf8').split('\n').filter((l) => l.length > 0);
else {
  // The same file often sits in several repositories; count it once.
  const byContent = new Map();
  for (const f of walk(corpus).filter((p) => p.includes(only)).sort()) {
    const hash = createHash('sha256').update(readFileSync(f)).digest('hex');
    if (!byContent.has(hash)) byContent.set(hash, f);
  }
  files = [...byContent.values()];
}
mkdirSync(out, { recursive: true });
const recordsPath = join(out, 'records.jsonl');
rmSync(recordsPath, { force: true });

const queue = [];
for (let i = 0; i < files.length; i += BATCH) queue.push(files.slice(i, i + BATCH));
let done = 0;

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
  else try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

function runBatch(id, batch) {
  return new Promise((finish) => {
    const list = join(out, `batch-${id}.list`);
    const lock = join(out, `batch-${id}.lock`);
    const part = join(out, `batch-${id}.jsonl`);
    writeFileSync(list, batch.join('\n'));
    const child = spawn(
      process.execPath,
      [join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', 'lib/fcstd-import/corpus/corpus.occt.test.ts', '--reporter=dot'],
      {
        cwd: repoRoot,
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        env: { ...process.env, FCSTD_CORPUS_LIST: list, FCSTD_CORPUS_OUT: part, FCSTD_CORPUS_LOCK: lock },
      },
    );
    const startedAt = Date.now();
    let hung = false;
    const watch = setInterval(() => {
      const stamps = [startedAt];
      for (const p of [lock, part]) if (existsSync(p)) stamps.push(statSync(p).mtimeMs);
      if (Date.now() - Math.max(...stamps) > timeoutSec * 1000) {
        hung = true;
        killTree(child.pid);
      }
    }, 5000);
    child.on('exit', () => {
      clearInterval(watch);
      const written = existsSync(part) ? readFileSync(part, 'utf8').split('\n').filter((l) => l.length > 0) : [];
      if (written.length > 0) appendFileSync(recordsPath, `${written.join('\n')}\n`);
      done += written.length;
      const processed = new Set(written.map((l) => JSON.parse(l).file));
      const rest = batch.filter((f) => !processed.has(f));
      if (rest.length > 0) {
        const culprit = existsSync(lock) ? readFileSync(lock, 'utf8') : rest[0];
        appendFileSync(recordsPath, `${JSON.stringify({ file: culprit, version: '', types: {}, bodies: [], notes: [], pauses: [], error: hung ? 'hang' : 'crash', ms: 0 })}\n`);
        done += 1;
        const remaining = rest.filter((f) => f !== culprit);
        if (remaining.length > 0) queue.push(remaining);
      }
      for (const p of [list, lock, part]) rmSync(p, { force: true });
      process.stdout.write(`${done}/${files.length}\n`);
      finish();
    });
  });
}

let nextId = 0;
async function worker() {
  for (;;) {
    const batch = queue.shift();
    if (batch === undefined) return;
    await runBatch(nextId++, batch);
  }
}

await Promise.all(Array.from({ length: jobs }, worker));
spawnSync(process.execPath, [join(here, 'summarize.mjs'), '--records', recordsPath, '--out', out], { stdio: 'inherit' });
