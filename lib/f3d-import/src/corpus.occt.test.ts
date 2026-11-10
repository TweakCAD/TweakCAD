/**
 * Real files, imported and built on the real kernel and solver, and compared
 * with reference solids measured from a STEP export of each. Files can't live
 * in the repository, so this is skipped unless F3D_CORPUS points at a folder
 * holding a manifest.json. F3D_REF names the measured solids, F3D_REPORT the
 * output (one JSON line per file); F3D_LIST, F3D_ONLY, F3D_MAX_BYTES, F3D_EVERY
 * and F3D_OFFSET pick the files.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper } from '@salusoft89/planegcs';
import { describe, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { readDocument } from '@tweakcad/format';
import { seededIds } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import type { SurfaceSpec } from '@tweakcad/worker/src/v2/service/onSurfaces';
import { complete, importF3d, type F3dClient } from './index';

const corpus = process.env['F3D_CORPUS'];
const refPath = process.env['F3D_REF'];
const maxBytes = Number(process.env['F3D_MAX_BYTES'] ?? 6e6);
const every = Number(process.env['F3D_EVERY'] ?? 1);
const offset = Number(process.env['F3D_OFFSET'] ?? 0);
const only = process.env['F3D_ONLY'];
const listPath = process.env['F3D_LIST'];
const here = dirname(fileURLToPath(import.meta.url));

type Solid = { v: number; min: number[]; max: number[] };
type Ref = { error?: string; solids?: number; volume?: number; per?: Solid[] };
type Row = Record<string, unknown>;

/** A placement as the kernel's 3 × 4 matrix. */
function matrixOf(p: { position: number[]; rotation: number[] }): number[] {
  const [x, y, z, w] = p.rotation as [number, number, number, number];
  const [tx, ty, tz] = p.position as [number, number, number];
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    tx,
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    ty,
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
    tz,
  ];
}

const VOLUME = 0.005;
const BOX = 0.1;
const sameBox = (a: Solid, b: Solid) =>
  [0, 1, 2].every(
    (i) =>
      Math.abs((a.min[i] as number) - (b.min[i] as number)) <= BOX &&
      Math.abs((a.max[i] as number) - (b.max[i] as number)) <= BOX,
  );
const sameVolume = (a: Solid, b: Solid) => Math.abs(a.v - b.v) <= VOLUME * Math.max(Math.abs(b.v), 1e-9);

describe.skipIf(!corpus)('real files against reference solids', () => {
  it('reports', { timeout: 7_200_000 }, async () => {
    const manifest = JSON.parse(readFileSync(join(corpus as string, 'manifest.json'), 'utf8')) as {
      files: { localPath: string; size: number; sha256: string; step: unknown }[];
    };
    const ref = refPath ? (JSON.parse(readFileSync(refPath, 'utf8')) as Record<string, Ref>) : {};
    const log = process.env['F3D_REPORT'] ?? 'f3d-corpus.jsonl';
    const done = new Set<string>();
    if (existsSync(log))
      for (const line of readFileSync(log, 'utf8').split('\n'))
        if (line) done.add((JSON.parse(line) as { path: string }).path);
    const listed = listPath
      ? new Set(
          readFileSync(listPath, 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean),
        )
      : null;
    const wasm = [3, 4, 5]
      .map((up) =>
        resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
      )
      .find((p) => existsSync(p));
    if (!wasm) throw new Error('planegcs.wasm not found');

    const start = async () => {
      const k = await OcctKernel.init();
      const service = new EvaluationService(k, await make_gcs_wrapper(realpathSync(wasm)));
      const client: F3dClient = {
        evaluate: (doc, options) => Promise.resolve(service.evaluate(doc as Row, options)),
        vetSketch: (inputs) => Promise.resolve(service.vetSketch(inputs as Row)),
        vetSketches: (doc, features) => Promise.resolve(service.vetSketches(doc as Row, features)),
        locateOnSurfaces: (part, before, pairs: [SurfaceSpec, SurfaceSpec][]) =>
          Promise.resolve(service.locateOnSurfaces(part, before, pairs)),
        bodiesMadeBy: (part, before, features) => Promise.resolve(service.bodiesMadeBy(part, before, features)),
        locateFacesOnSurfaces: (part, before, surfaces) =>
          Promise.resolve(service.locateFacesOnSurfaces(part, before, surfaces)),
      };
      return { k, service, client };
    };
    let session = await start();

    let i = -1;
    for (const f of manifest.files) {
      i++;
      if (listed && !listed.has(f.localPath)) continue;
      if (only ? !f.localPath.includes(only) : f.size > maxBytes || (i + offset) % every !== 0) continue;
      if (done.has(f.localPath)) continue;
      const r = ref[f.sha256.slice(0, 12)];
      // Recorded before the work, so a hard crash names its file and the rerun moves on.
      appendFileSync(log, `${JSON.stringify({ path: f.localPath, started: true })}\n`);
      const row: Row = { path: f.localPath, status: 'ok' };
      const t0 = performance.now();
      try {
        const imported = importF3d(new Uint8Array(readFileSync(join(corpus as string, f.localPath))), {
          ids: seededIds(7),
          writer: { app: 'corpus', version: '0' },
          name: 'corpus',
          now: '2026-11-06T00:00:00Z',
        });
        if (!imported.ok) throw new Error(imported.error);
        const { document, steps, notes, report } = imported.value;
        row.convertMs = Math.round(performance.now() - t0);
        const late = await complete(document, steps, session.client);
        row.completeMs = Math.round(performance.now() - t0) - (row.convertMs as number);
        const refused = readDocument(document).diagnostics.filter((d) => d.severity === 'refuse');
        const shown = performance.now();
        const display = session.service.evaluate(document);
        row.evaluateMs = Math.round(performance.now() - shown);
        const got: Solid[] = [];
        const k = session.k;
        const placements = ((document.assemblies as Row[])[0]?.instances as Row[] | undefined)?.map((i) => ({
          part: ((i.of as Row).part as Row).id as string,
          at: i.placement as { position: number[]; rotation: number[] },
        }));
        const rootPart = ((document.root as Row).part as Row | undefined)?.id as string | undefined;
        for (const { part, at } of placements ?? [{ part: rootPart as string, at: undefined }]) {
          for (const shape of session.service.evaluation?.parts.get(part)?.shapes.values() ?? []) {
            for (const solid of k.getSubShapes(shape, 'solid')) {
              const placed = at ? k.transform(solid, matrixOf(at)) : solid;
              const b = k.getBoundingBox(placed);
              // References are in the file's axes: a turned design is turned back, (x, y, z) to (x, −z, y).
              const back = report.upAxis === 'z';
              got.push({
                v: k.getVolume(solid),
                min: back ? [b.xmin, -b.zmax, b.ymin] : [b.xmin, b.ymin, b.zmin],
                max: back ? [b.xmax, -b.zmin, b.ymax] : [b.xmax, b.ymax, b.zmax],
              });
              if (at) k.release(placed);
            }
          }
        }
        const pauses: Record<string, number> = {};
        for (const p of display.pauses) {
          const k = p.message.replace(/[0-9a-z_]{20,}/gi, '#').slice(0, 80);
          pauses[k] = (pauses[k] ?? 0) + 1;
        }
        // What each feature type came to: written, and of those, paused.
        const written: Record<string, number> = {};
        const pausedBy: Record<string, number> = {};
        const typeOf = new Map<string, string>();
        for (const part of document.parts as Row[]) {
          for (const row of part.timeline as Row[]) {
            typeOf.set(row.id as string, row.type as string);
            written[row.type as string] = (written[row.type as string] ?? 0) + 1;
          }
        }
        for (const p of display.pauses) {
          const type = typeOf.get(p.feature ?? '') ?? '?';
          pausedBy[type] = (pausedBy[type] ?? 0) + 1;
        }
        const used = new Array<boolean>(got.length).fill(false);
        let exact = 0;
        let volumeOnly = 0;
        for (const s of r?.per ?? []) {
          let k = got.findIndex((x, j) => !used[j] && sameVolume(x, s) && sameBox(x, s));
          if (k >= 0) {
            used[k] = true;
            exact++;
            continue;
          }
          k = got.findIndex((x, j) => !used[j] && sameVolume(x, s));
          if (k >= 0) {
            used[k] = true;
            volumeOnly++;
          }
        }
        Object.assign(row, {
          ms: Math.round(performance.now() - t0),
          sketches: report.sketches.length,
          extrudes: report.extrudes,
          revolves: report.revolves,
          rounds: report.rounds,
          bodySteps: report.bodySteps,
          parts: report.parts,
          rows: (document.parts as Row[]).reduce((n, p) => n + (p.timeline as Row[]).length, 0),
          rootKind: Object.keys(document.root as Row)[0],
          upAxis: report.upAxis,
          why: notes.find((n) => n.object === 'timeline' && n.severity === 'warning')?.message,
          instances: report.instances,
          constraints: report.sketches.reduce((n, s) => n + s.constraints, 0),
          leftOut: report.leftOut,
          refused: refused.slice(0, 3).map((d) => `${d.path} ${d.message}`.slice(0, 120)),
          notes: [...notes, ...late].filter((n) => n.severity === 'warning').length,
          late: late.map((n) => n.message.replace(/\d+/g, 'N').slice(0, 70)).slice(0, 4),
          dropped:
            late.filter((n) => n.object === 'document').map((n) => Number(/\d+/.exec(n.message)?.[0] ?? 0))[0] ?? 0,
          pauses,
          written,
          pausedBy,
          ref: r?.per?.length ?? null,
          got: got.length,
          exact,
          volumeOnly,
          missing: (r?.per?.length ?? 0) - exact - volumeOnly,
          extra: used.filter((u) => !u).length,
        });
      } catch (e) {
        row.status = String((e as Error).message).slice(0, 120);
        session = await start();
      }
      appendFileSync(log, `${JSON.stringify(row)}\n`);
    }
  });
});
