import { describe, expect, it } from 'vitest';
import { readDocument } from '../model';
import { NameTable } from '../names';
import { addBox, FACE_ROLES, FakeKernel, type FakeBox } from './fakeKernel';
import type { OperationHistory, ShapeKey, ShapeRef, ShapeTopology } from './facts';
import { startFeature } from './namer';
import { finest, withChain } from './names';
import { resolve, writeRecord } from './resolve';
import { NamedState } from './state';

const F_BOX = 'feat_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const F_TOOL = 'feat_aeaqcaibaeaqcaibaeaqcaibae';
const F_CUT = 'feat_aiaqeaibaiaqeaibaiaqeaibai';

const empty = () => ({ kept: [], modified: new Map<ShapeKey, ShapeKey[]>(), deleted: [], added: [] });

/** A fresh shape with no inputs. */
function fresh(shape: ShapeRef): OperationHistory {
  return {
    result: shape,
    inputs: [],
    faces: empty(),
    edges: empty(),
    facesFromFace: new Map(),
    facesFromEdge: new Map(),
  };
}

/** Names a new box as a primitive: one role per face, body `[index(0)]`. */
function nameBox(
  kernel: FakeKernel,
  names: NameTable,
  state: NamedState,
  box: FakeBox,
  feature: string,
  ordinal: number,
) {
  const namer = startFeature(state, { feature, ordinal }, kernel, names);
  namer.step(fresh(box.shape), {
    outputs: FACE_ROLES.map((role) => ({ entity: box.faces[role], role, src: [] })),
    dividers: [],
  });
  return namer.finish([{ solid: box.solid, from: { create: [{ index: 0 }] } }]);
}

/** Box 0..10 with a slot tool 4.9..5.1 cut through it in x, keys from `base`. */
function slotted(base: number) {
  const kernel = new FakeKernel();
  const names = new NameTable();
  const box = addBox(kernel, 'box', base, [0, 0, 0], [10, 10, 10]);
  const tool = addBox(kernel, 'tool', base + 100, [4.9, -1, -1], [5.1, 11, 11]);
  let state = nameBox(kernel, names, NamedState.empty(), box, F_BOX, 0);
  state = nameBox(kernel, names, state, tool, F_TOOL, 1);
  const beforeCut = state;

  const a = addBox(kernel, 'a', base + 200, [0, 0, 0], [4.9, 10, 10]);
  const b = addBox(kernel, 'b', base + 300, [5.1, 0, 0], [10, 10, 10]);
  const ta = kernel.topology('a');
  const tb = kernel.topology('b');
  const cut: ShapeTopology = {
    faces: [...ta.faces, ...tb.faces],
    edges: [...ta.edges, ...tb.edges],
    vertices: [...ta.vertices, ...tb.vertices],
    solids: [...ta.solids, ...tb.solids],
  };
  kernel.shapes.set('cut', cut);
  const modified = new Map<ShapeKey, ShapeKey[]>();
  for (const role of ['+y', '-y', '+z', '-z'] as const) modified.set(box.faces[role], [a.faces[role], b.faces[role]]);
  modified.set(box.faces['-x'], [a.faces['-x']]);
  modified.set(box.faces['+x'], [b.faces['+x']]);
  modified.set(tool.faces['-x'], [a.faces['+x']]);
  modified.set(tool.faces['+x'], [b.faces['-x']]);
  const namer = startFeature(state, { feature: F_CUT, ordinal: 2 }, kernel, names);
  namer.step(
    {
      result: 'cut',
      inputs: [
        { shape: 'box', use: 'target' },
        { shape: 'tool', use: 'tool' },
      ],
      faces: { kept: [], modified, deleted: [], added: [] },
      edges: empty(),
      facesFromFace: new Map(),
      facesFromEdge: new Map(),
    },
    { outputs: [], dividers: Object.values(tool.faces) },
  );
  state = namer.finish([
    { solid: a.solid, from: { carry: ['box'] } },
    { solid: b.solid, from: { carry: ['box'] } },
  ]);
  return { kernel, names, box, tool, a, b, beforeCut, state };
}

describe('naming', () => {
  it('gives the same names whatever keys the kernel uses', () => {
    const run = (base: number) => {
      const kernel = new FakeKernel();
      const names = new NameTable();
      const box = addBox(kernel, 'box', base, [0, 0, 0], [10, 20, 30]);
      const state = nameBox(kernel, names, NamedState.empty(), box, F_BOX, 0);
      return {
        top: state.get(box.faces['+z'])?.ladder,
        edge: state.get(box.edge('+x', '+z'))?.ladder,
        body: state.get(box.solid)?.ladder,
        count: state.entities.size,
      };
    };
    const first = run(100);
    expect(first).toEqual(run(9000));
    expect(first.top).toHaveLength(2); // a primitive's face: level 0 and its role
    expect(first.edge).toHaveLength(3);
    expect(first.count).toBe(6 + 12 + 8 + 1);
  });

  it("inherits an edge's branch entries in the order of its faces' names, not the kernel's adjacency order", () => {
    const S1 = 'feat_bmbmbmbmbmbmbmbmbmbmbmbmbm';
    const S2 = 'feat_cmcmcmcmcmcmcmcmcmcmcmcmcm';
    const branchOf = (reversed: boolean) => {
      const kernel = new FakeKernel();
      const names = new NameTable();
      const box = addBox(kernel, 'box', 100, [0, 0, 0], [10, 10, 10]);
      const named = nameBox(kernel, names, NamedState.empty(), box, F_BOX, 0);
      const entities = new Map(named.entities);
      const split = (role: '+x' | '+z', split: string) => {
        const e = entities.get(box.faces[role])!;
        entities.set(box.faces[role], { ...e, branch: [{ split, side: [] }] });
      };
      split('+x', S1);
      split('+z', S2);
      const edge = box.edge('+x', '+z');
      if (reversed) {
        const t = kernel.topology('box');
        kernel.shapes.set('box', {
          ...t,
          edges: t.edges.map((e) => (e.edge === edge ? { ...e, faces: [...e.faces].reverse() } : e)),
        });
      }
      const state = new NamedState(entities, named.bodies, new Set([S1, S2]), named.producers);
      const namer = startFeature(state, { feature: F_CUT, ordinal: 1 }, kernel, names);
      namer.step(
        { ...fresh('box'), faces: { ...empty(), kept: Object.values(box.faces) } },
        { outputs: [], dividers: [] },
      );
      const after = namer.finish([]);
      return { branch: after.get(edge)?.branch.map((b) => b.split), ladder: after.get(edge)?.ladder };
    };
    const plain = branchOf(false);
    expect(new Set(plain.branch)).toEqual(new Set([S1, S2]));
    expect(branchOf(true)).toEqual(plain);
  });

  it('names cut pieces by which side of the cutter they lie on', () => {
    const { state, a, b } = slotted(100);
    const pa = state.get(a.faces['+y']);
    const pb = state.get(b.faces['+y']);
    expect(pa?.ladder).toEqual(pb?.ladder);
    expect(pa?.branch[0]?.split).toBe(F_CUT);
    expect(pa?.branch).not.toEqual(pb?.branch);
    expect(state.splits.has(F_CUT)).toBe(true);
    // The two pieces are two bodies with the box's identity, told apart by branch.
    expect(state.get(a.solid)?.ladder).toEqual(state.get(b.solid)?.ladder);
    expect(state.get(a.solid)?.branch).not.toEqual(state.get(b.solid)?.branch);
  });

  it('finds a picked piece again after a rebuild with other keys', () => {
    const first = slotted(100);
    const record = writeRecord(first.state.get(first.a.faces['+y'])!, first.state, first.kernel);
    expect(record.n).toBe(1);
    const again = slotted(5000);
    const found = resolve(record, again.state, again.kernel);
    expect(found).toEqual({ outcome: 'same', entities: [again.state.get(again.a.faces['+y'])] });
  });

  it('asks when a picked whole face has since been split, and finds the whole face without the split', () => {
    const { beforeCut, state, kernel, box } = slotted(100);
    const record = writeRecord(beforeCut.get(box.faces['+y'])!, beforeCut, kernel);
    expect(resolve(record, state, kernel).outcome).toBe('ask');

    // A piece picked with the cut resolves to the whole face where the split is not in effect.
    const withCut = slotted(100);
    const pieceRecord = writeRecord(withCut.state.get(withCut.a.faces['+y'])!, withCut.state, withCut.kernel);
    const found = resolve(pieceRecord, withCut.beforeCut, withCut.kernel);
    expect(found).toEqual({ outcome: 'same', entities: [withCut.beforeCut.get(withCut.box.faces['+y'])] });
  });

  it('keeps a joined tool face findable through its alias', () => {
    const kernel = new FakeKernel();
    const names = new NameTable();
    const left = addBox(kernel, 'left', 100, [0, 0, 0], [10, 10, 10]);
    const right = addBox(kernel, 'right', 200, [10, 0, 0], [20, 10, 10]);
    let state = nameBox(kernel, names, NamedState.empty(), left, F_BOX, 0);
    state = nameBox(kernel, names, state, right, F_TOOL, 1);
    const toolTop = writeRecord(state.get(right.faces['+z'])!, state, kernel);

    const joined = addBox(kernel, 'joined', 300, [0, 0, 0], [20, 10, 10]);
    const modified = new Map<ShapeKey, ShapeKey[]>();
    for (const role of ['+y', '-y', '+z', '-z'] as const) {
      modified.set(left.faces[role], [joined.faces[role]]);
      modified.set(right.faces[role], [joined.faces[role]]);
    }
    modified.set(left.faces['-x'], [joined.faces['-x']]);
    modified.set(right.faces['+x'], [joined.faces['+x']]);
    const namer = startFeature(state, { feature: F_CUT, ordinal: 2 }, kernel, names);
    namer.step(
      {
        result: 'joined',
        inputs: [
          { shape: 'left', use: 'target' },
          { shape: 'right', use: 'tool' },
        ],
        faces: { kept: [], modified, deleted: [left.faces['+x'], right.faces['-x']], added: [] },
        edges: empty(),
        facesFromFace: new Map(),
        facesFromEdge: new Map(),
      },
      { outputs: [], dividers: [] },
    );
    const after = namer.finish([{ solid: joined.solid, from: { carry: ['left', 'right'] } }]);

    const top = after.get(joined.faces['+z'])!;
    expect(top.ladder).toEqual(state.get(left.faces['+z'])!.ladder); // the target's face survives
    expect(top.aliases.map((a) => a.hash)).toContain(finest(state.get(right.faces['+z'])!.ladder));
    expect(resolve(toolTop, after, kernel)).toEqual({ outcome: 'same', entities: [top] });
    // The joined body is the earliest-created body, the tool body its alias.
    expect(after.get(joined.solid)!.ladder).toEqual(state.get(left.solid)!.ladder);
  });

  it('names a copy with its source names plus the copy step, and finds it again', () => {
    const run = (base: number) => {
      const kernel = new FakeKernel();
      const names = new NameTable();
      const box = addBox(kernel, 'box', base, [0, 0, 0], [10, 10, 10]);
      let state = nameBox(kernel, names, NamedState.empty(), box, F_BOX, 0);
      // The top stands in for the -x face, as a blend does.
      const blend = state.get(box.faces['+z'])!;
      const standing = new Map(state.entities).set(blend.key, {
        ...blend,
        standsFor: [finest(state.get(box.faces['-x'])!.ladder)],
      });
      state = new NamedState(standing, state.bodies, state.splits, state.producers);
      const copy = addBox(kernel, 'copy', base + 500, [20, 0, 0], [30, 10, 10]);
      const faces = new Map<ShapeKey, ShapeKey[]>(FACE_ROLES.map((r) => [box.faces[r], [copy.faces[r]]]));
      const edges = new Map<ShapeKey, ShapeKey[]>();
      for (const a of FACE_ROLES) {
        for (const b of FACE_ROLES) {
          if (a < b && a[1] !== b[1]) edges.set(box.edge(a, b), [copy.edge(a, b)]);
        }
      }
      const namer = startFeature(state, { feature: F_CUT, ordinal: 1 }, kernel, names);
      namer.copy(
        {
          result: 'copy',
          inputs: [{ shape: 'box', use: 'target' }],
          faces: { kept: [], modified: faces, deleted: [], added: [] },
          edges: { kept: [], modified: edges, deleted: [], added: [] },
          facesFromFace: new Map(),
          facesFromEdge: new Map(),
        },
        { op: { id: F_CUT }, key: { slot: { i: 1, j: 0 } } },
      );
      state = namer.finish([]);
      return { kernel, names, box, copy, state };
    };
    const { names, box, copy, state, kernel } = run(100);
    const source = state.get(box.faces['+z'])!;
    const top = state.get(copy.faces['+z'])!;
    expect(top.ladder).not.toEqual(source.ladder);
    expect(state.entities.size).toBe(2 * (6 + 12 + 8 + 1));
    // An edge keeps its source's src; only the chain changes.
    const level = (h: string) => names.get(h) as { chain: unknown[]; src?: unknown };
    const sourceEdge = level(finest(state.get(box.edge('+x', '+z'))!.ladder));
    const copyEdge = level(finest(state.get(copy.edge('+x', '+z'))!.ladder));
    expect(copyEdge.src).toEqual(sourceEdge.src);
    expect(copyEdge.chain).toEqual([{ op: { id: F_CUT }, key: { slot: { i: 1, j: 0 } } }]);
    expect(top.standsFor).toEqual([finest(state.get(copy.faces['-x'])!.ladder)]);
    expect(top.createdBy).toBe(F_CUT);
    // A pick on the copy survives a rebuild.
    const record = writeRecord(top, state, kernel);
    const again = run(7000);
    expect(resolve(record, again.state, again.kernel)).toEqual({
      outcome: 'same',
      entities: [again.state.get(again.copy.faces['+z'])],
    });
  });

  it('copies a shape from names recorded in an earlier feature, after that feature consumed it', () => {
    const kernel = new FakeKernel();
    const names = new NameTable();
    const tool = addBox(kernel, 'tool', 100, [0, 0, 0], [10, 10, 10]);
    const first = startFeature(NamedState.empty(), { feature: F_TOOL, ordinal: 0 }, kernel, names);
    first.step(fresh('tool'), {
      outputs: FACE_ROLES.map((role) => ({ entity: tool.faces[role], role, src: [] })),
      dividers: [],
    });
    // Faces only: edges and vertices are named when a feature finishes.
    const recorded = first.namesOf('tool');
    expect([...recorded.keys()].sort()).toEqual(Object.values(tool.faces).sort());

    const copy = addBox(kernel, 'copy', 600, [20, 0, 0], [30, 10, 10]);
    const step = { op: { id: F_CUT }, key: { slot: { i: 1, j: 0 } } };
    // The tool is in no state the copying feature sees.
    const namer = startFeature(NamedState.empty(), { feature: F_CUT, ordinal: 1 }, kernel, names);
    namer.copy(
      {
        result: 'copy',
        inputs: [{ shape: 'tool', use: 'target' }],
        faces: {
          kept: [],
          modified: new Map(FACE_ROLES.map((r) => [tool.faces[r], [copy.faces[r]]])),
          deleted: [],
          added: [],
        },
        edges: empty(),
        facesFromFace: new Map(),
        facesFromEdge: new Map(),
      },
      step,
      recorded,
    );
    const state = namer.finish([]);
    for (const role of FACE_ROLES) {
      const source = recorded.get(tool.faces[role])!;
      expect(state.get(copy.faces[role])!.ladder).toEqual(source.ladder.map((h) => withChain(h, [step], names)));
    }
    expect(state.get(tool.faces['+z'])).toBeUndefined();
  });

  it('writes records the document reader accepts, branch and all', () => {
    const { state, kernel, names, a } = slotted(100);
    const record = writeRecord(state.get(a.faces['+y'])!, state, kernel);
    expect(record.branch[0]?.split).toEqual({ id: F_CUT });
    const part = 'part_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const doc = {
      format: 'tweakcad.document',
      schemaVersion: 2,
      namingRules: 1,
      id: 'doc_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      metadata: {
        name: 'R',
        description: '',
        createdAt: '2026-11-05T00:00:00Z',
        updatedAt: '2026-11-05T00:00:00Z',
        writer: { app: 't', version: '0' },
        origin: { original: {} },
      },
      properties: {},
      settings: {},
      parameters: [],
      parts: [
        {
          id: part,
          name: 'P',
          parameters: [],
          timeline: [],
          rollback: { end: {} },
          groups: [],
          sets: [{ id: 'set_aaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'S', members: { set: [{ entity: record }] } }],
          contexts: [],
          attributes: [],
          configurations: [],
          notes: [],
          properties: {},
        },
      ],
      assemblies: [],
      root: { part: { id: part } },
      folders: [],
      views: [],
      library: [],
      assets: {},
      names: names.toJson(),
    };
    const result = readDocument(JSON.parse(JSON.stringify(doc)));
    expect(result.diagnostics.filter((d) => d.severity === 'refuse')).toEqual([]);
  });

  it('reports a pick whose name no longer exists as gone', () => {
    const { state, kernel, names } = slotted(100);
    const record = {
      id: [names.intern({ kind: 'face', chain: [], feature: { id: 'feat_aqaqaqaqaqaqaqaqaqaqaqaqaq' } })],
      branch: [],
      side: [],
      nb: { set: [] },
      n: 1,
      snapshot: {},
    };
    expect(resolve(record, state, kernel)).toEqual({ outcome: 'gone' });
  });
});
