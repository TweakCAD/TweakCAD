#!/usr/bin/env node
/**
 * Turn the per-file records of a corpus run into report.json and report.md,
 * with deltas against an earlier report.json when one is given.
 *
 *   node lib/fcstd-import/corpus/summarize.mjs --records <records.jsonl> --out <dir>
 *        [--baseline <report.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const records = readFileSync(arg('records'), 'utf8')
  .split('\n')
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l));
const out = arg('out');
const baselinePath = arg('baseline', '');
const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) : undefined;

/** Document scaffolding: dropping one of these loses nothing of the model. */
const INFRASTRUCTURE = new Set([
  'App::Origin', 'App::Plane', 'App::Line', 'App::Point', 'App::DocumentObjectGroup',
  'App::DocumentObjectGroupPython', 'App::TextDocument', 'App::Annotation',
  'App::MaterialObjectPython', 'App::MaterialObject', 'PartDesign::FeatureBase',
]);
/** Workbenches with no counterpart in a solid model. */
const OUT_OF_SCOPE = /^(Fem|Path|CAM|TechDraw|Drawing|Assembly|Mesh|Image|Robot|Inspection|Points|ReverseEngineering|Surface|Measure|Web)::/;
const isModel = (t) => t.length > 0 && !INFRASTRUCTURE.has(t) && !OUT_OF_SCOPE.test(t);

function add(into, from) {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

const totals = {
  files: records.length,
  filesFailed: {},
  objects: {},
  carried: {},
  filesWithType: {},
  constraints: {},
  constraintsImported: {},
  geometry: {},
  geometryImported: {},
  sketchSupport: {},
  properties: {},
  diagnostics: {},
  unitVerdicts: { body: {}, root: {} },
  failures: {},
  eras: {},
  blockers: {},
  soleBlockers: {},
  unexplainedByFailure: {},
};
const mismatches = [];
let filesComparable = 0;
let filesMatching = 0;
let bodiesUnexplained = 0;

for (const r of records) {
  if (r.error) {
    const reason = r.error.slice(0, 60);
    totals.filesFailed[reason] = (totals.filesFailed[reason] ?? 0) + 1;
  }
  add(totals.objects, r.census.objects);
  add(totals.carried, r.census.carried);
  for (const t of Object.keys(r.census.objects)) {
    totals.filesWithType[t] = (totals.filesWithType[t] ?? 0) + 1;
  }
  add(totals.constraints, r.census.constraints);
  add(totals.constraintsImported, r.constraintsImported);
  add(totals.geometry, r.census.geometry);
  add(totals.geometryImported, r.geometryImported);
  add(totals.sketchSupport, r.census.sketchSupport);
  add(totals.properties, r.census.properties);
  add(totals.diagnostics, r.diagnostics);
  const era = r.programVersion.slice(0, 4) || '?';
  totals.eras[era] = (totals.eras[era] ?? 0) + 1;
  const comparable = r.units.filter((u) => u.verdict !== 'noOracle');
  if (comparable.length > 0) {
    filesComparable += 1;
    if (comparable.every((u) => u.verdict === 'match')) filesMatching += 1;
  }
  for (const u of r.units) {
    const bucket = totals.unitVerdicts[u.kind];
    bucket[u.verdict] = (bucket[u.verdict] ?? 0) + 1;
    for (const f of u.failures) {
      const message = f.replace(/\[.*$/, '').trim();
      totals.failures[message] = (totals.failures[message] ?? 0) + 1;
    }
    if (u.verdict !== 'match' && u.verdict !== 'noOracle' && u.kind === 'body') {
      const blockers = u.blockers ?? [];
      mismatches.push({
        file: basename(r.file),
        body: u.name,
        verdict: u.verdict,
        volumeError: u.volumeError,
        bboxError: u.bboxError,
        blockers,
        failures: u.failures,
      });
      for (const b of blockers) totals.blockers[b] = (totals.blockers[b] ?? 0) + 1;
      if (blockers.length === 1) totals.soleBlockers[blockers[0]] = (totals.soleBlockers[blockers[0]] ?? 0) + 1;
      if (blockers.length === 0) {
        bodiesUnexplained += 1;
        totals.unexplainedByFailure[u.verdict] = (totals.unexplainedByFailure[u.verdict] ?? 0) + 1;
      }
    }
  }
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

/**
 * Which blockers to clear first. A body only comes right once all its blockers
 * are gone, so a plain count of holders overrates anything that always appears
 * alongside something else. Greedily take the blocker that frees the most
 * bodies given those already taken, breaking ties by how many bodies hold it.
 */
function fixOrder(failing) {
  const remaining = failing.map((m) => new Set(m.blockers));
  const steps = [];
  let freed = remaining.filter((s) => s.size === 0).length;
  for (;;) {
    const gain = new Map();
    const holders = new Map();
    for (const set of remaining) {
      for (const b of set) {
        holders.set(b, (holders.get(b) ?? 0) + 1);
        if (set.size === 1) gain.set(b, (gain.get(b) ?? 0) + 1);
      }
    }
    if (holders.size === 0) return steps;
    const pick = [...holders.keys()].sort(
      (x, y) => (gain.get(y) ?? 0) - (gain.get(x) ?? 0) || holders.get(y) - holders.get(x),
    )[0];
    for (const set of remaining) set.delete(pick);
    const now = remaining.filter((s) => s.size === 0).length;
    steps.push({ blocker: pick, frees: now - freed, cumulative: now });
    freed = now;
  }
}
const modelObjects = Object.entries(totals.objects).filter(([t]) => isModel(t));
const bodyVerdicts = totals.unitVerdicts.body;
const rootVerdicts = totals.unitVerdicts.root;
const comparableBodies = sum(bodyVerdicts) - (bodyVerdicts.noOracle ?? 0);
const headline = {
  files: totals.files,
  filesFailed: sum(totals.filesFailed),
  filesComparable,
  filesMatching,
  bodiesUnexplained,
  bodies: comparableBodies,
  bodiesMatching: bodyVerdicts.match ?? 0,
  rootShapes: sum(rootVerdicts),
  rootShapesMatching: rootVerdicts.match ?? 0,
  modelObjects: modelObjects.reduce((a, [, c]) => a + c, 0),
  modelObjectsCarried: modelObjects.reduce((a, [t]) => a + (totals.carried[t] ?? 0), 0),
  constraints: sum(totals.constraints),
  constraintsImported: sum(totals.constraintsImported),
  geometry: sum(totals.geometry),
  geometryImported: sum(totals.geometryImported),
};

const order = fixOrder(mismatches);

writeFileSync(join(out, 'report.json'), JSON.stringify({ headline, totals, mismatches, order }, null, 1));

const pct = (a, b) => (b === 0 ? '–' : `${((100 * a) / b).toFixed(1)}%`);
const delta = (key) => {
  if (!baseline) return '';
  const d = headline[key] - (baseline.headline[key] ?? 0);
  return d === 0 ? '' : ` (${d > 0 ? '+' : ''}${d})`;
};
const row = (label, a, b) =>
  `| ${label} | ${headline[a]}${delta(a)} | ${headline[b]}${delta(b)} | ${pct(headline[a], headline[b])} |`;
const byCount = (o) => Object.entries(o).sort((x, y) => y[1] - x[1]);
const cell = (s) => s.replaceAll('|', '/');

const md = [
  '# FCStd corpus coverage',
  '',
  `${headline.files} files; ${headline.filesFailed} could not be processed.`,
  '',
  '| Measure | Covered | Total | Share |',
  '|---|---:|---:|---:|',
  row('Files where every shape matches', 'filesMatching', 'filesComparable'),
  row('Bodies matching their stored shape', 'bodiesMatching', 'bodies'),
  row('Root Part shapes matching', 'rootShapesMatching', 'rootShapes'),
  row('Model objects carried', 'modelObjectsCarried', 'modelObjects'),
  row('Sketch constraints imported', 'constraintsImported', 'constraints'),
  row('Sketch geometry imported', 'geometryImported', 'geometry'),
  '',
  '## FreeCAD versions',
  '',
  '| Version | Files |',
  '|---|---:|',
  ...byCount(totals.eras).map(([k, v]) => `| ${k} | ${v} |`),
  '',
  '## Body verdicts',
  '',
  '| Verdict | Bodies |',
  '|---|---:|',
  ...byCount(bodyVerdicts).map(([k, v]) => `| ${k} | ${v} |`),
  '',
  '## Root Part shape verdicts',
  '',
  '| Verdict | Shapes |',
  '|---|---:|',
  ...byCount(rootVerdicts).map(([k, v]) => `| ${k} | ${v} |`),
  '',
  '## What stands between failing bodies and their stored shape',
  '',
  `${headline.bodiesUnexplained} failing bodies hold nothing the importer is known to miss: those are importer bugs.`,
  '',
  '| Blocker | Failing bodies holding it | Bodies where it is the only one |',
  '|---|---:|---:|',
  ...byCount(totals.blockers).map(([k, v]) => `| ${k} | ${v} | ${totals.soleBlockers[k] ?? 0} |`),
  '',
  '## Order that frees the most failing bodies',
  '',
  'Bodies left with no known blocker after each step; they may still need bug fixes.',
  '',
  '| Step | Blocker | Freed | Cumulative |',
  '|---:|---|---:|---:|',
  ...order.slice(0, 30).map((s, i) => `| ${i + 1} | ${s.blocker} | ${s.frees} | ${s.cumulative} |`),
  '',
  '## Model object types',
  '',
  '| Type | Objects | Files | Carried |',
  '|---|---:|---:|---:|',
  ...modelObjects
    .sort((x, y) => y[1] - x[1])
    .map(([t, c]) => `| ${t} | ${c} | ${totals.filesWithType[t]} | ${totals.carried[t] ?? 0} |`),
  '',
  '## Sketch constraints',
  '',
  '| Type | Total | Imported |',
  '|---|---:|---:|',
  ...byCount(totals.constraints).map(([t, c]) => `| ${t} | ${c} | ${totals.constraintsImported[t] ?? 0} |`),
  '',
  '## Sketch geometry',
  '',
  '| Type | Total | Imported |',
  '|---|---:|---:|',
  ...byCount(totals.geometry).map(([t, c]) => `| ${t} | ${c} | ${totals.geometryImported[t] ?? 0} |`),
  '',
  '## Sketch attachment',
  '',
  '| Attached to | Sketches |',
  '|---|---:|',
  ...byCount(totals.sketchSupport).map(([k, v]) => `| ${k} | ${v} |`),
  '',
  '## Values a converter has to honour',
  '',
  '| Property | Count |',
  '|---|---:|',
  ...byCount(totals.properties).map(([k, v]) => `| ${k} | ${v} |`),
  '',
  '## Rebuild failures',
  '',
  '| Message | Count |',
  '|---|---:|',
  ...byCount(totals.failures).slice(0, 25).map(([k, v]) => `| ${cell(k)} | ${v} |`),
  '',
  '## Files that could not be processed',
  '',
  '| Reason | Files |',
  '|---|---:|',
  ...byCount(totals.filesFailed).map(([k, v]) => `| ${cell(k)} | ${v} |`),
  '',
];
writeFileSync(join(out, 'report.md'), md.join('\n'));
console.log(md.slice(0, 13).join('\n'));
