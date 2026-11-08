import { describe, expect, it } from 'vitest';
import { MeshStore, ProgressRelay } from './client';
import type { BodyDisplay, BodyMesh, Display, Progress } from './types';

describe('ProgressRelay', () => {
  it("passes on the newest job's progress only", () => {
    const relay = new ProgressRelay();
    const heard: Progress[] = [];
    const off = relay.listen((p) => heard.push(p));
    const first = relay.start();
    relay.receive({ job: first, phase: 'reading' });
    const second = relay.start();
    // The first job, superseded, still reports; the second has started.
    relay.receive({ job: first, phase: 'meshing', done: 3, total: 9 });
    relay.receive({ job: second, phase: 'placing' });
    expect(heard).toEqual([{ phase: 'reading' }, { phase: 'placing' }]);
    off();
    relay.receive({ job: second, phase: 'reading' });
    expect(heard).toHaveLength(2);
  });
});

const mesh = (n: number): BodyMesh => ({
  positions: new Float32Array(n),
  normals: new Float32Array(n),
  indices: new Uint32Array(0),
  faces: new Uint32Array(0),
  segments: new Float32Array(0),
  edges: new Uint32Array(0),
  points: new Float32Array(0),
  vertices: new Uint32Array(0),
});

const body = (key: number, m: BodyMesh, mark: Partial<BodyDisplay> = {}): BodyDisplay => ({
  key,
  id: `b${key}`,
  feature: 'f',
  name: `Body ${key}`,
  color: '#6699cc',
  opacity: 1,
  visible: true,
  faceStyles: [],
  mesh: m,
  ...mark,
});

const display = (generation: number, bodies: BodyDisplay[], restyled?: number): Display => ({
  generation,
  ...(restyled !== undefined ? { restyled } : {}),
  definitions: [
    { index: 0, part: 'p', variant: '', rollback: null, bodies, sketches: [], construction: [], threads: [] },
  ],
  parts: { p: 0 },
  assemblies: [],
  entities: [],
  pauses: [],
  stale: [],
  outOfDate: [],
  timing: { evaluate: 0, display: 0, resumed: 0 },
});

describe('MeshStore', () => {
  it("fills a kept body with its geometry and the pick tables it came with, and holds the last displays' geometries only", () => {
    const store = new MeshStore();
    const a = mesh(9);
    const b = mesh(6);
    store.fill(display(1, [body(1, a, { geometry: 10 }), body(2, mesh(0), { unmeshed: true })]));
    expect(store.held()).toEqual([10]);
    // The first body's geometry kept, with new pick tables; the second shown and meshed now.
    const tables = { ...mesh(0), faces: new Uint32Array([0, 3, 7]) };
    const next = store.fill(
      display(2, [body(5, tables, { kept: true, geometry: 10 }), body(6, b, { geometry: 11 })]),
    ) as Display;
    const [ka, kb] = next.definitions[0]!.bodies;
    expect([ka!.kept, ka!.mesh.positions, ka!.mesh.faces, kb!.mesh]).toEqual([undefined, a.positions, tables.faces, b]);
    expect(ka!.mesh.positions).toBe(a.positions);
    expect(store.held().sort()).toEqual([10, 11]);
    // Three displays without geometry 10, and it is let go.
    for (const g of [3, 4, 5]) store.fill(display(g, [body(6, mesh(0), { kept: true, geometry: 11 })]));
    expect(store.held()).toEqual([11]);
    expect(store.fill(display(6, [body(1, mesh(0), { kept: true, geometry: 10 })]))).toBeNull();
  });
});
