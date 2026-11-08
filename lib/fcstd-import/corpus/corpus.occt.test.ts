/**
 * Imports each file of a list, finishes and evaluates it on the real kernel
 * and compares every Body with the shape the file itself stores. Runs only
 * when driven by `run-corpus.mjs`, which owns the file list, restarts after a
 * hang or a crash and writes the summary.
 *
 * FCSTD_CORPUS_LIST  text file, one .FCStd path per line
 * FCSTD_CORPUS_OUT   JSON Lines output, one record per file, appended
 * FCSTD_CORPUS_LOCK  rewritten with the path of the file in progress
 */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { describe, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { seededIds } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import { readArchive } from '../src/archive';
import { complete } from '../src/complete';
import { link, parseDocument, shapeFile } from '../src/document';
import { importFcstd } from '../src/index';
import type { Json } from '../src/writer';

const LIST = process.env.FCSTD_CORPUS_LIST;
const OUT = process.env.FCSTD_CORPUS_OUT ?? '';
const LOCK = process.env.FCSTD_CORPUS_LOCK ?? '';
/** Set to 0 to measure what rebuilds, without the stored shapes standing in. */
const CHECK = process.env.FCSTD_CORPUS_CHECK !== '0';

interface BodyRecord {
  label: string;
  verdict: 'match' | 'volume' | 'box' | 'empty' | 'noOracle' | 'missing';
  want?: number;
  got?: number;
}

interface FileRecord {
  file: string;
  version: string;
  types: Record<string, number>;
  bodies: BodyRecord[];
  notes: string[];
  pauses: string[];
  /** Solid bodies the imported document shows. */
  solids?: number;
  expressions?: { carried: number; dropped: number };
  error?: string;
  ms: number;
}

/** Numbers and quoted names out of a message, so messages of one kind count together. */
const template = (m: string) => m.replace(/\d+(\.\d+)?/g, 'N');

function box(p: Float32Array, min: number[], max: number[]): void {
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a] as number, p[i + a] as number);
      max[a] = Math.max(max[a] as number, p[i + a] as number);
    }
  }
}

async function processFile(file: string, gcs: GcsWrapper): Promise<FileRecord> {
  const started = Date.now();
  const record: FileRecord = { file, version: '', types: {}, bodies: [], notes: [], pauses: [], ms: 0 };
  const bytes = new Uint8Array(readFileSync(file));
  const archive = readArchive(bytes);
  if (!archive.ok) {
    record.error = `archive: ${archive.error}`;
    return record;
  }
  const doc = parseDocument(archive.value.documentXml);
  if (!doc.ok) {
    record.error = `document: ${doc.error}`;
    return record;
  }
  record.version = doc.value.programVersion ?? '';
  for (const o of doc.value.objects) record.types[o.type] = (record.types[o.type] ?? 0) + 1;

  const k = await OcctKernel.init();
  const service = new EvaluationService(k, gcs);
  try {
    const imported = importFcstd(bytes, { ids: seededIds(1), writer: { app: 'corpus', version: '0' }, name: 'corpus' });
    if (!imported.ok) throw new Error(imported.error);
    const { document, steps, notes, checks, styles, expressions } = imported.value;
    record.expressions = expressions;
    const client = {
      evaluate: (d: unknown, options?: { meshes?: boolean }) => Promise.resolve(service.evaluate(d as Json, options)),
      locate: (
        part: string,
        before: string | undefined,
        brep: string,
        kind: 'edge' | 'face',
        indices: number[] | 'all',
        ofFaces?: number[],
      ) => Promise.resolve(service.locate(part, before, brep, kind, indices, ofFaces)),
      bodyRecords: (part: string, before: string | undefined) => Promise.resolve(service.bodyRecords(part, before)),
      importFile: (b: Uint8Array, format: 'brep', feature: string, name: string) =>
        Promise.resolve(service.importFile(b, format, feature, name)),
      shapeMeasures: (brep: string) => Promise.resolve(service.shapeMeasures(brep)),
      stepMeasures: (part: string, feature: string) => Promise.resolve(service.stepMeasures(part, feature)),
    };
    const late = await complete(document, steps, client, CHECK ? checks : [], styles);
    record.notes = [...notes, ...late].filter((n) => n.severity === 'warning').map((n) => template(n.message));
    const display = service.evaluate(document);
    record.pauses = display.pauses.map((p) => template(p.message));
    record.solids = display.definitions.reduce((n, d) => n + d.bodies.length, 0);

    const parts = (document.parts as Json[]).map((p) => ({ id: p.id as string, name: p.name as string }));
    for (const body of doc.value.objects.filter((o) => o.type === 'PartDesign::Body')) {
      const label = body.label;
      const tip = doc.value.byName.get(link(body, 'Tip')?.obj ?? '');
      const stored = tip && shapeFile(tip);
      const data = stored ? archive.value.files.get(stored) : undefined;
      if (!data) {
        record.bodies.push({ label, verdict: 'noOracle' });
        continue;
      }
      const oracle = k.fromBREP(new TextDecoder().decode(data));
      // Solid by solid, as a body here is measured: the kernel's volume of a compound can differ from the sum of its solids.
      const solids = k.getSubShapes(oracle, 'solid');
      const want = solids.length > 0 ? solids.reduce((v, s) => v + k.getVolume(s), 0) : k.getVolume(oracle);
      const wantBox = k.getBoundingBox(oracle);
      const part = parts.find((p) => p.name === label);
      const def = part && display.definitions.find((d) => d.part === part.id && d.variant === '');
      if (!def) {
        k.release(oracle);
        record.bodies.push({ label, verdict: 'missing', want });
        continue;
      }
      let got = 0;
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const b of def.bodies) {
        const m = service.measure('volume', [b.key]);
        if ('value' in m) got += m.value;
        box(b.mesh.positions, min, max);
      }
      if (want <= 0) {
        k.release(oracle);
        record.bodies.push({ label, verdict: 'noOracle', got });
        continue;
      }
      const diag = Math.hypot(wantBox.xmax - wantBox.xmin, wantBox.ymax - wantBox.ymin, wantBox.zmax - wantBox.zmin);
      const tolerance = Math.max(0.02, diag * 0.005);
      const w = [wantBox.xmin, wantBox.ymin, wantBox.zmin, wantBox.xmax, wantBox.ymax, wantBox.zmax];
      const g = [...min, ...max];
      const boxOk = g.every((v, i) => Math.abs(v - (w[i] as number)) <= tolerance);
      // A swept face's box can reach past where the face is trimmed: its mesh says where the solid ends.
      const meshed = boxOk || !(Math.abs(got / want - 1) <= 1e-3) ? undefined : k.tessellate(oracle);
      const meshMin = [Infinity, Infinity, Infinity];
      const meshMax = [-Infinity, -Infinity, -Infinity];
      if (meshed) box(meshed.positions, meshMin, meshMax);
      const meshOk =
        meshed !== undefined &&
        [...min, ...max].every((v, i) => Math.abs(v - ([...meshMin, ...meshMax][i] as number)) <= tolerance);
      k.release(oracle);
      const verdict =
        def.bodies.length === 0
          ? 'empty'
          : Math.abs(got / want - 1) > 1e-3
            ? 'volume'
            : boxOk || meshOk
              ? 'match'
              : 'box';
      record.bodies.push({ label, verdict, want, got });
    }
  } catch (e) {
    record.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
  }
  try {
    service.release();
    k.releaseAll();
  } catch {
    // The next file gets a fresh kernel.
  }
  record.ms = Date.now() - started;
  return record;
}

describe.skipIf(LIST === undefined)('FreeCAD corpus', () => {
  it('runs the list', { timeout: 24 * 3_600_000 }, async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const wasm = [3, 4, 5]
      .map((up) =>
        resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
      )
      .find((p) => existsSync(p));
    if (!wasm) throw new Error('planegcs.wasm not found');
    const gcs = await make_gcs_wrapper(realpathSync(wasm));
    for (const file of readFileSync(LIST as string, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)) {
      writeFileSync(LOCK, file);
      appendFileSync(OUT, `${JSON.stringify(await processFile(file, gcs))}\n`);
    }
  });
});
