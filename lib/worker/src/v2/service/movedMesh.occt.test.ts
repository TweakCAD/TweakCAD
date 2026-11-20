/**
 * A body that only moved is meshed as its source located where it lies,
 * reusing the source's triangulation: its display matches the same body
 * built in place, face by face, edge by edge, and its pick keys name its own
 * faces.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { makeSet } from '@tweakcad/format';
import { DocBuilder } from '../docBuilder';
import type { Json } from '../context';
import { bodyRef } from '../primitivesDocs';
import { EvaluationService } from './service';
import { meshArea, meshVolume } from './testKit';
import type { BodyDisplay, Display } from './types';

let k: OcctKernel;

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  k.releaseAll();
});

const PLACED = 'placement(vector(12 mm, -4 mm, 7 mm), rotate(vector(1, 0, 0), 30 deg))';

function cylinder(d: DocBuilder, placed: boolean): string {
  return d.feature('core.primitive', {
    shape: { cylinder: { radius: d.val('6 mm'), height: d.val('10 mm') } },
    frame: {
      fixed: {
        placement: d.val(placed ? PLACED : 'placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(1, 0, 0), 0 deg))'),
      },
    },
    operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
  });
}

/** A cylinder at the origin, and the document with it moved to `PLACED` (or copied there). */
function moved(copy: boolean): { before: Json; after: Json } {
  const d = new DocBuilder();
  const made = cylinder(d, false);
  const before = d.document();
  d.feature('core.move', {
    of: { bodies: makeSet([bodyRef(d, made)]) },
    transform: d.val(PLACED),
    copy: d.val(String(copy)),
  });
  return { before, after: d.document() };
}

function placedInPlace(): Json {
  const d = new DocBuilder();
  cylinder(d, true);
  return d.document();
}

const bodiesOf = (display: Display): BodyDisplay[] => display.definitions.flatMap((def) => def.bodies);

function bounds(xyz: ArrayLike<number>): number[] {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < xyz.length; i += 3)
    for (let c = 0; c < 3; c++) {
      out[c] = Math.min(out[c] as number, xyz[i + c] as number);
      out[c + 3] = Math.max(out[c + 3] as number, xyz[i + c] as number);
    }
  return out;
}

/** Each face range's area, sorted, and the counts of faces, edges and vertices drawn. */
function summary(body: BodyDisplay) {
  const { mesh } = body;
  const areas: number[] = [];
  for (let i = 0; i < mesh.faces.length; i += 3)
    areas.push(meshArea(mesh, mesh.faces[i] as number, mesh.faces[i + 1] as number));
  return {
    areas: areas.sort((a, b) => a - b),
    edges: mesh.edges.length / 3,
    vertices: mesh.vertices.length,
    volume: meshVolume(mesh),
    bounds: bounds(mesh.positions),
    segments: bounds(mesh.segments),
  };
}

function expectSame(a: BodyDisplay, b: BodyDisplay): void {
  const x = summary(a);
  const y = summary(b);
  expect(x.areas).toEqual(y.areas.map((v) => expect.closeTo(v, 3)));
  expect([x.edges, x.vertices]).toEqual([y.edges, y.vertices]);
  expect(x.volume).toBeCloseTo(y.volume, 3);
  expect(x.bounds).toEqual(y.bounds.map((v) => expect.closeTo(v, 4)));
  expect(x.segments).toEqual(y.segments.map((v) => expect.closeTo(v, 4)));
}

describe('a moved body on display', { timeout: 60_000 }, () => {
  it('matches the body built where it was moved to, and picks its own faces', () => {
    const service = new EvaluationService(k);
    const reference = new EvaluationService(k);
    try {
      const { before, after } = moved(false);
      service.evaluate(before);
      const located = vi.spyOn(k, 'located');
      const meshed = vi.spyOn(k, 'meshShape');
      const display = service.evaluate(after);
      // The moved body was meshed as its source located there, not afresh.
      const placed = located.mock.results.map((r) => r.value as unknown);
      expect(placed).toHaveLength(1);
      expect(meshed.mock.calls.map((c) => c[0] as unknown)).toEqual(placed);
      located.mockRestore();
      meshed.mockRestore();
      const [body] = bodiesOf(display);
      const [built] = bodiesOf(reference.evaluate(placedInPlace()));
      expectSame(body as BodyDisplay, built as BodyDisplay);
      // Every drawn face, edge and vertex is a pick key of the moved body.
      const keys = [
        ...[...(body as BodyDisplay).mesh.faces].filter((_, i) => i % 3 === 2),
        ...[...(body as BodyDisplay).mesh.edges].filter((_, i) => i % 3 === 2),
        ...(body as BodyDisplay).mesh.vertices,
      ];
      const infos = service.entities(keys);
      expect(infos.map((e) => e.body)).toEqual(keys.map(() => (body as BodyDisplay).key));
      expect(new Set(keys).size).toBe(keys.length);
    } finally {
      service.release();
      reference.release();
    }
  });

  it('draws a moved copy as the source drawn there, beside the source', () => {
    const service = new EvaluationService(k);
    const reference = new EvaluationService(k);
    try {
      const { after } = moved(true);
      const bodies = bodiesOf(service.evaluate(after));
      expect(bodies).toHaveLength(2);
      const [built] = bodiesOf(reference.evaluate(placedInPlace()));
      const copy = bodies.find((b) => (summary(b).bounds[0] as number) > 1) as BodyDisplay;
      expectSame(copy, built as BodyDisplay);
    } finally {
      service.release();
      reference.release();
    }
  });
});
