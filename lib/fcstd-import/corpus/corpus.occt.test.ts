/**
 * Imports each file of a list, rebuilds every part on the real kernel and
 * compares it with the solved shape the file itself carries. Runs only when
 * driven by `run-corpus.mjs`, which owns the file list, restarts after a hang
 * or a crash and writes the summary.
 *
 * FCSTD_CORPUS_LIST  text file, one .FCStd path per line
 * FCSTD_CORPUS_OUT   JSON Lines output, one record per file, appended
 * FCSTD_CORPUS_LOCK  rewritten with the path of the file in progress
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { attachTestSolver } from '@tweakcad/testing/src/solver.ts';
import type { CadProject } from '@tweakcad/core/src/document/schema.ts';
import {
  clearRebuildCache,
  incrementalRebuild,
  releaseRebuildBodies,
  sweepPreviousRebuild,
} from '@tweakcad/worker/src/rebuilder.ts';
import { importFcstd, readFcstdArchive } from '../src/index.ts';
import type { FcstdImportReport } from '../src/index.ts';
import { censusDocument } from './census.ts';
import type { CensusUnit, DocumentCensus } from './census.ts';

type Measure = { volume: number; min: number[]; max: number[]; bodies: number };

type UnitVerdict = 'match' | 'volume' | 'bbox' | 'empty' | 'notImported' | 'noOracle' | 'error';

type UnitRecord = {
  name: string;
  type: string;
  kind: CensusUnit['kind'];
  verdict: UnitVerdict;
  blockers: string[];
  oracle?: Measure;
  rebuilt?: Measure;
  volumeError?: number;
  bboxError?: number;
  failures: string[];
};

type FileRecord = {
  file: string;
  programVersion: string;
  census: Omit<DocumentCensus, 'units' | 'objects' | 'programVersion'> & {
    objects: Record<string, number>;
    carried: Record<string, number>;
  };
  constraintsImported: Record<string, number>;
  geometryImported: Record<string, number>;
  units: UnitRecord[];
  diagnostics: Record<string, number>;
  error?: string;
  ms: number;
};

/** Relative volume difference a rebuilt shape may show and still count as the same shape. */
const VOLUME_TOLERANCE = 1e-3;
/** Bounding-box difference allowed, as a fraction of the oracle's diagonal, with an absolute floor in mm. */
const BBOX_TOLERANCE = 2e-3;
const BBOX_FLOOR_MM = 0.02;

function emptyRecord(file: string): FileRecord {
  return {
    file,
    programVersion: '',
    census: { objects: {}, carried: {}, constraints: {}, geometry: {}, sketchSupport: {}, properties: {} },
    constraintsImported: {},
    geometryImported: {},
    units: [],
    diagnostics: {},
    ms: 0,
  };
}

async function measure(kernel: OcctKernel, bodies: KernelBody[]): Promise<Measure> {
  const m: Measure = {
    volume: 0,
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    bodies: bodies.length,
  };
  for (const body of bodies) {
    const mass = await kernel.getMassProperties(body);
    const box = await kernel.getBoundingBox(body);
    m.volume += mass.volume;
    for (let i = 0; i < 3; i++) {
      m.min[i] = Math.min(m.min[i]!, box.min[i]!);
      m.max[i] = Math.max(m.max[i]!, box.max[i]!);
    }
  }
  return m;
}

function bboxError(a: Measure, b: Measure): number {
  let worst = 0;
  for (let i = 0; i < 3; i++) {
    worst = Math.max(worst, Math.abs(a.min[i]! - b.min[i]!), Math.abs(a.max[i]! - b.max[i]!));
  }
  return worst;
}

function diagonal(m: Measure): number {
  return Math.hypot(m.max[0]! - m.min[0]!, m.max[1]! - m.min[1]!, m.max[2]! - m.min[2]!);
}

async function readOracle(
  kernel: OcctKernel,
  files: Record<string, Uint8Array>,
  unit: CensusUnit,
): Promise<Measure | undefined> {
  const bytes = unit.shapeFile === undefined ? undefined : files[unit.shapeFile];
  if (!bytes || bytes.length === 0) return undefined;
  const imported = await kernel.importBrep(bytes.slice().buffer as ArrayBuffer, `oracle-${unit.name}`);
  if (!imported.ok || imported.value.length === 0) return undefined;
  const m = await measure(kernel, imported.value);
  releaseRebuildBodies(kernel, imported.value.map((handle) => ({ handle })));
  return m.volume > 0 ? m : undefined;
}

async function compareUnit(
  kernel: OcctKernel,
  unit: CensusUnit,
  files: Record<string, Uint8Array>,
  imported: { project: CadProject; report: FcstdImportReport },
): Promise<UnitRecord | undefined> {
  const entry: UnitRecord = {
    name: unit.name,
    type: unit.type,
    kind: unit.kind,
    verdict: 'noOracle',
    blockers: unit.blockers,
    failures: [],
  };
  const oracle = await readOracle(kernel, files, unit);
  if (oracle === undefined) {
    // A shape enclosing no volume (a wire, a face, a Draft line) is not a
    // solid to reproduce; only a body stays in the record, to show its absence.
    return unit.kind === 'body' ? entry : undefined;
  }
  entry.oracle = oracle;

  const partId = imported.report.parts[unit.name];
  const part = partId === undefined ? undefined : imported.project.parts[partId];
  if (part === undefined) {
    entry.verdict = 'notImported';
    return entry;
  }

  clearRebuildCache();
  const result = await incrementalRebuild(part, imported.project, kernel, 0);
  for (const r of result.featureResults) {
    if (r.status === 'failed') entry.failures.push((r.error?.message ?? 'failed').slice(0, 160));
  }
  const rebuilt = await measure(kernel, result.bodies.map((b) => b.handle));
  sweepPreviousRebuild(kernel, String(part.id));

  if (rebuilt.volume <= 0) {
    entry.verdict = 'empty';
    return entry;
  }
  entry.rebuilt = rebuilt;
  entry.volumeError = Math.abs(rebuilt.volume - oracle.volume) / oracle.volume;
  entry.bboxError = bboxError(rebuilt, oracle);
  const bboxAllowed = Math.max(BBOX_FLOOR_MM, BBOX_TOLERANCE * diagonal(oracle));
  if (entry.volumeError > VOLUME_TOLERANCE) entry.verdict = 'volume';
  else entry.verdict = entry.bboxError > bboxAllowed ? 'bbox' : 'match';
  return entry;
}

async function processFile(file: string): Promise<FileRecord> {
  const started = Date.now();
  const record = emptyRecord(file);
  const input = new Uint8Array(readFileSync(file));

  const archive = await readFcstdArchive(input);
  if (!archive.ok) {
    record.error = archive.error;
    return record;
  }

  const census = censusDocument(archive.value.documentXml);
  record.programVersion = census.programVersion;
  record.census.constraints = census.constraints;
  record.census.geometry = census.geometry;
  record.census.sketchSupport = census.sketchSupport;
  record.census.properties = census.properties;
  for (const o of census.objects) {
    record.census.objects[o.type] = (record.census.objects[o.type] ?? 0) + 1;
  }

  const imported = await importFcstd(input);
  if (!imported.ok) {
    record.error = imported.error;
    return record;
  }
  const { diagnostics, report } = imported.value;
  record.constraintsImported = report.constraintsImported;
  record.geometryImported = report.geometryImported;
  for (const d of diagnostics) record.diagnostics[d.code] = (record.diagnostics[d.code] ?? 0) + 1;
  for (const o of census.objects) {
    if (report.features[o.name] !== undefined || report.parts[o.name] !== undefined) {
      record.census.carried[o.type] = (record.census.carried[o.type] ?? 0) + 1;
    }
  }

  const kernel = new OcctKernel();
  await kernel.init();
  for (const unit of census.units) {
    try {
      const entry = await compareUnit(kernel, unit, archive.value.files, imported.value);
      if (entry) record.units.push(entry);
    } catch (e) {
      record.units.push({
        name: unit.name,
        type: unit.type,
        kind: unit.kind,
        verdict: 'error',
        blockers: unit.blockers,
        failures: [(e instanceof Error ? e.message : String(e)).slice(0, 160)],
      });
    }
  }

  record.ms = Date.now() - started;
  return record;
}

const listPath = process.env['FCSTD_CORPUS_LIST'];
const outPath = process.env['FCSTD_CORPUS_OUT'];
const lockPath = process.env['FCSTD_CORPUS_LOCK'];

describe.skipIf(!listPath || !outPath || !lockPath)('FCStd corpus', () => {
  it('imports and compares every listed file', async () => {
    await attachTestSolver();
    const files = readFileSync(listPath!, 'utf8').split('\n').filter((l) => l.length > 0);
    for (const file of files) {
      writeFileSync(lockPath!, file);
      let record: FileRecord;
      try {
        record = await processFile(file);
      } catch (e) {
        record = { ...emptyRecord(file), error: e instanceof Error ? e.message : String(e) };
      }
      appendFileSync(outPath!, `${JSON.stringify(record)}\n`);
    }
  }, 0);
});
