import { describe, expect, it } from 'vitest';
import {
  NamingAdapterError,
  buildOperationHistory,
  decodeIndexed,
  type HeldKey,
  type HistoryLists,
  type InputSubShapes,
  type ResultSubShapes,
} from './namingAdapterHistory.ts';

const head = { result: 'out', inputs: [{ shape: 'in', use: 'target' as const }] };
const noLists: HistoryLists = {
  modifiedIndexed: [],
  generatedIndexed: [],
  edgeModifiedIndexed: [],
  edgeGeneratedIndexed: [],
};

/** Kernel kind numbers. */
const SOLID = 2;
const FACE = 4;
const EDGE = 6;

/** A key, or a key and the `same` id it shares with another key of its sub-shape. */
type Held = number | readonly [key: number, same: number];

const held = (h: Held): HeldKey => (typeof h === 'number' ? { key: h, same: h } : { key: h[0], same: h[1] });

/** One input's faces and edges, by position. */
const input = (faces: Held[], edges: Held[] = []): InputSubShapes => ({
  faces: faces.map(held),
  edges: edges.map(held),
});

/** The result's faces and edges by position, and how many solids it has. */
function result(faces: Held[], edges: Held[] = [], solids = 0): ResultSubShapes {
  const kinds: HeldKey[][] = Array.from({ length: 8 }, () => []);
  kinds[SOLID] = Array.from({ length: solids }, (_, i) => held(900 + i));
  kinds[FACE] = faces.map(held);
  kinds[EDGE] = edges.map(held);
  return kinds;
}

describe('decodeIndexed', () => {
  it('reads runs, including empty ones', () => {
    expect(decodeIndexed([0, 3, 2, FACE, 1, EDGE, 0, 1, 0, 0])).toEqual([
      {
        input: 0,
        position: 3,
        images: [
          [FACE, 1],
          [EDGE, 0],
        ],
      },
      { input: 1, position: 0, images: [] },
    ]);
    expect(decodeIndexed([])).toEqual([]);
  });

  it('refuses a list that ends inside a run', () => {
    expect(() => decodeIndexed([0, 1, 2, FACE, 0])).toThrow(NamingAdapterError);
    expect(() => decodeIndexed([0, 1])).toThrow(NamingAdapterError);
  });
});

describe('buildOperationHistory', () => {
  it("sorts inputs into kept, modified and deleted without reading the kernel's delete lists", () => {
    const h = buildOperationHistory(
      { ...noLists, modifiedIndexed: [0, 1, 2, FACE, 1, FACE, 2] },
      [input([1, 2, 3])],
      result([1, 5, 6, 7]),
      head,
    );
    expect(h.faces.kept).toEqual([1]);
    expect(h.faces.modified).toEqual(new Map([[2, [5, 6]]]));
    expect(h.faces.deleted).toEqual([3]);
    expect(h.faces.added).toEqual([7]);
  });

  it('deletes an input listed with no image of its kind', () => {
    const h = buildOperationHistory(
      { ...noLists, modifiedIndexed: [0, 0, 1, EDGE, 0], edgeModifiedIndexed: [0, 0, 1, EDGE, 0] },
      [input([1], [3])],
      result([], [4]),
      head,
    );
    expect(h.faces.deleted).toEqual([1]);
    expect(h.edges.modified).toEqual(new Map([[3, [4]]]));
  });

  it('sorts edges from faces and other kinds in generated lists', () => {
    const h = buildOperationHistory(
      {
        ...noLists,
        generatedIndexed: [0, 0, 3, FACE, 1, EDGE, 0, SOLID, 0],
        edgeGeneratedIndexed: [0, 0, 2, FACE, 2, EDGE, 1],
      },
      [input([1], [3])],
      result([1, 5, 6, 7], [8, 9, 10], 1),
      head,
    );
    expect(h.facesFromFace).toEqual(new Map([[1, [5]]]));
    expect(h.facesFromEdge).toEqual(new Map([[3, [6]]]));
    // Generated faces and edges have history; only the rest count as added.
    expect(h.faces.added).toEqual([7]);
    expect(h.edges.added).toEqual([10]);
  });

  it('counts a generated face as no image of its source', () => {
    const h = buildOperationHistory(
      { ...noLists, edgeGeneratedIndexed: [0, 0, 1, FACE, 0] },
      [input([], [3])],
      result([5]),
      head,
    );
    expect(h.edges.deleted).toEqual([3]);
    expect(h.facesFromEdge).toEqual(new Map([[3, [5]]]));
  });

  it('refuses a list naming an input or result sub-shape that is not there', () => {
    const build = (lists: Partial<HistoryLists>) =>
      buildOperationHistory({ ...noLists, ...lists }, [input([1], [3])], result([5], [6]), head);
    expect(() => build({ modifiedIndexed: [1, 0, 1, FACE, 0] })).toThrow(/Input 1 has no face at 0/);
    expect(() => build({ modifiedIndexed: [0, 1, 1, FACE, 0] })).toThrow(/Input 0 has no face at 1/);
    expect(() => build({ edgeGeneratedIndexed: [0, 0, 1, FACE, 1] })).toThrow(/The result has no face at 1/);
    expect(() => build({ generatedIndexed: [0, 0, 1, 9, 0] })).toThrow(expect.objectContaining({ code: 'malformed' }));
  });

  it('leaves kept faces out of the generated maps', () => {
    const h = buildOperationHistory(
      { ...noLists, generatedIndexed: [0, 0, 1, FACE, 0] },
      [input([1])],
      result([1]),
      head,
    );
    expect(h.faces.kept).toEqual([1]);
    expect(h.facesFromFace.size).toBe(0);
  });

  it('treats an input listed as becoming only itself as kept', () => {
    const h = buildOperationHistory(
      { ...noLists, modifiedIndexed: [0, 0, 1, FACE, 0] },
      [input([1])],
      result([1]),
      head,
    );
    expect(h.faces.kept).toEqual([1]);
    expect(h.faces.modified.size).toBe(0);
  });

  it('keeps a surviving input among its images when it also became something else', () => {
    const h = buildOperationHistory(
      { ...noLists, modifiedIndexed: [0, 0, 2, FACE, 0, FACE, 1] },
      [input([1])],
      result([1, 5]),
      head,
    );
    expect(h.faces.kept).toEqual([]);
    expect(h.faces.modified).toEqual(new Map([[1, [1, 5]]]));
  });

  it('reports a face held the other way round as modified into its new key', () => {
    const h = buildOperationHistory(noLists, [input([1])], result([[2, 1]]), head);
    expect(h.faces.kept).toEqual([]);
    expect(h.faces.modified).toEqual(new Map([[1, [2]]]));
    expect(h.faces.added).toEqual([]);
  });

  it('merges several inputs into one result, by input number', () => {
    const h = buildOperationHistory(
      { ...noLists, modifiedIndexed: [0, 0, 1, FACE, 0, 1, 0, 1, FACE, 0] },
      [input([1]), input([2])],
      result([5]),
      head,
    );
    expect(h.faces.modified).toEqual(
      new Map([
        [1, [5]],
        [2, [5]],
      ]),
    );
  });

  it('gives each key of a face two inputs hold different ways round the images listed for it', () => {
    const h = buildOperationHistory(
      { ...noLists, modifiedIndexed: [0, 0, 1, FACE, 0, 1, 0, 1, FACE, 0] },
      [input([[1, 1]]), input([[2, 1]])],
      result([5]),
      head,
    );
    expect(h.faces.modified).toEqual(
      new Map([
        [1, [5]],
        [2, [5]],
      ]),
    );
  });

  it('counts a sub-shape two inputs share once', () => {
    const h = buildOperationHistory(noLists, [input([1, 2]), input([2, 3])], result([2]), head);
    expect(h.faces.kept).toEqual([2]);
    expect(h.faces.deleted).toEqual([1, 3]);
  });
});
