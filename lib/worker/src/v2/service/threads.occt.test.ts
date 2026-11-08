/**
 * Cosmetic threads in the display: each lies on the keys of the faces it
 * threads, with its pitch, side and run along the cylinder, and follows an
 * edit of the parameter that sizes it. A modelled thread is geometry, so
 * the display lists none for it.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import type { Json } from '../context';
import { EvaluationService } from './service';
import type { DefinitionDisplay, Display, ThreadDisplay } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolvePath(HERE, '../../../../testing/fixtures/v2');
const fixture = (name: string): Json => JSON.parse(readFileSync(resolvePath(DIR, `${name}.cadjson`), 'utf8')) as Json;

let k: OcctKernel;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  // The fixtures size their sketches by parameters, so a size change needs the solver.
  const wasm = [4, 5, 6]
    .map((up) =>
      resolvePath(HERE, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  service = new EvaluationService(k, await make_gcs_wrapper(realpathSync(wasm)));
});
afterAll(() => {
  service.release();
  k.releaseAll();
});

function partOf(display: Display): DefinitionDisplay {
  const index = Object.values(display.parts)[0];
  const def = index === undefined ? undefined : display.definitions[index];
  if (!def) throw new Error('no part');
  return def;
}

/** The parameter `name` of the document's first part set to `text`. */
function withParameter(doc: Json, name: string, text: string): Json {
  const out = structuredClone(doc);
  for (const table of ((out.parts as Json[])[0] as Json).parameters as Json[]) {
    for (const p of table.parameters as Json[])
      if (p.name === name) ((p.value as Json).def as Json).expr = { grammar: 1, refs: {}, text };
  }
  return out;
}

/** The mesh vertices of a thread's faces, each as its distance from the thread's axis and its place along it. */
function onAxis(def: DefinitionDisplay, t: ThreadDisplay): { across: number; along: number }[] {
  const faces = new Set(t.faces);
  const out: { across: number; along: number }[] = [];
  for (const b of def.bodies) {
    const m = b.mesh;
    for (let i = 0; i + 2 < m.faces.length; i += 3) {
      if (!faces.has(m.faces[i + 2] as number)) continue;
      const first = m.faces[i] as number;
      for (let tri = first; tri < first + (m.faces[i + 1] as number); tri++) {
        for (let c = 0; c < 3; c++) {
          const v = m.indices[3 * tri + c] as number;
          const d = [0, 1, 2].map((j) => (m.positions[3 * v + j] as number) - t.start[j as 0 | 1 | 2]);
          const along = d[0]! * t.direction[0] + d[1]! * t.direction[1] + d[2]! * t.direction[2];
          const across = Math.hypot(
            d[0]! - along * t.direction[0],
            d[1]! - along * t.direction[1],
            d[2]! - along * t.direction[2],
          );
          out.push({ across, along });
        }
      }
    }
  }
  return out;
}

/** Every vertex of the thread's faces lies on its cylinder, inside its run. */
function expectOnItsFaces(def: DefinitionDisplay, t: ThreadDisplay): void {
  const points = onAxis(def, t);
  expect(points.length).toBeGreaterThan(0);
  for (const p of points) {
    expect(Math.abs(p.across - t.radius)).toBeLessThan(1e-3);
    expect(p.along).toBeGreaterThan(-1e-3);
    expect(p.along).toBeLessThan(t.length + 1e-3);
  }
}

describe('cosmetic threads in the display', { timeout: 120_000 }, () => {
  it("shows the bolt's thread on its shank, external, M6 × 1, and follows the size", () => {
    const doc = fixture('hex-bolt-iso4017');
    const def = partOf(service.evaluate(doc));
    expect(def.threads).toHaveLength(1);
    const t = def.threads[0] as ThreadDisplay;
    expect(t).toMatchObject({ designation: 'M6', class: '6g', internal: false, pitch: 1 });
    expect(t.radius).toBeCloseTo(3, 6);
    expect(t.faces.length).toBeGreaterThan(0);
    const display = service.evaluate(doc);
    for (const key of partOf(display).threads[0]!.faces) expect(display.entities[key]?.kind).toBe('face');
    expectOnItsFaces(partOf(display), partOf(display).threads[0]!);

    const m10 = partOf(service.evaluate(withParameter(doc, 'Size', '"M10"')));
    expect(m10.threads).toHaveLength(1);
    expect(m10.threads[0]).toMatchObject({ designation: 'M10', internal: false, pitch: 1.5 });
    expect(m10.threads[0]!.radius).toBeCloseTo(5, 6);
    expectOnItsFaces(m10, m10.threads[0]!);
  });

  it("shows the nut's tapped hole as an internal thread on its bore, after the chamfer", () => {
    const doc = fixture('hex-nut-iso4032');
    const def = partOf(service.evaluate(doc));
    expect(def.threads).toHaveLength(1);
    const t = def.threads[0] as ThreadDisplay;
    expect(t).toMatchObject({ designation: 'M6', class: '6H', internal: true, pitch: 1 });
    // The bore is drilled at the tap drill.
    expect(t.radius).toBeCloseTo(2.5, 6);
    expectOnItsFaces(def, t);

    const m10 = partOf(service.evaluate(withParameter(doc, 'Size', '"M10"')));
    expect(m10.threads[0]).toMatchObject({ designation: 'M10', internal: true, pitch: 1.5 });
    expect(m10.threads[0]!.radius).toBeCloseTo(4.25, 6);
  });

  it('shows the screw and the rod threaded, and each hole of a pattern on its own bore', () => {
    for (const name of ['socket-screw-iso4762', 'threaded-rod']) {
      const def = partOf(service.evaluate(fixture(name)));
      expect(def.threads.map((t) => `${t.designation} ${t.internal ? 'internal' : 'external'}`)).toEqual([
        'M6 external',
      ]);
      expectOnItsFaces(def, def.threads[0]!);
    }
    const plate = partOf(service.evaluate(fixture('plate-hole-pattern')));
    expect(plate.threads).toHaveLength(3);
    const seen = new Set<number>();
    for (const t of plate.threads) {
      expect(t.internal).toBe(true);
      expectOnItsFaces(plate, t);
      for (const f of t.faces) {
        expect(seen.has(f)).toBe(false);
        seen.add(f);
      }
    }
  });

  it('lists no thread for a modelled one, nor before the thread feature', () => {
    expect(partOf(service.evaluate(fixture('hex-bolt-iso4017-modelled'))).threads).toEqual([]);
    const doc = fixture('hex-bolt-iso4017');
    const part = (doc.parts as Json[])[0] as Json;
    const thread = (part.timeline as Json[]).find((f) => f.type === 'core.thread') as Json;
    part.rollback = { before: { id: thread.id } };
    expect(partOf(service.evaluate(doc)).threads).toEqual([]);
  });
});
