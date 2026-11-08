import { describe, expect, it } from 'vitest';
import {
  NamingAdapterError,
  buildOperationHistory,
  decodeRunLength,
  type HistoryLists,
  type InputIndex,
  type ResultIndex,
} from './namingAdapterHistory.ts';

const head = { result: 'out', inputs: [{ shape: 'in', use: 'target' as const }] };
const noLists: HistoryLists = { modified: [], generated: [], edgeModified: [], edgeGenerated: [] };

function index(pairs: readonly [number, number][]): Map<number, number> {
  return new Map(pairs);
}

function input(faces: readonly [number, number[]][], edges: readonly [number, number[]][] = []): InputIndex {
  return { faces: new Map(faces), edges: new Map(edges) };
}

function result(
  faces: readonly [number, number][],
  edges: readonly [number, number][] = [],
  others: number[] = [],
): ResultIndex {
  return { faces: index(faces), edges: index(edges), others: new Set(others) };
}

describe('decodeRunLength', () => {
  it('reads entries, including empty ones', () => {
    expect(decodeRunLength([7, 2, 1, 2, 8, 0, 9, 1, 3])).toEqual([
      [7, [1, 2]],
      [8, []],
      [9, [3]],
    ]);
    expect(decodeRunLength([])).toEqual([]);
  });

  it('refuses a list that ends inside an entry', () => {
    expect(() => decodeRunLength([7, 3, 1])).toThrow(NamingAdapterError);
    expect(() => decodeRunLength([7])).toThrow(NamingAdapterError);
  });
});

describe('buildOperationHistory', () => {
  it("sorts inputs into kept, modified and deleted without reading the kernel's delete lists", () => {
    const h = buildOperationHistory(
      { ...noLists, modified: [11, 2, 21, 22] },
      input([
        [10, [1]],
        [11, [2]],
        [12, [3]],
      ]),
      result([
        [10, 1],
        [21, 5],
        [22, 6],
        [23, 7],
      ]),
      head,
    );
    expect(h.faces.kept).toEqual([1]);
    expect(h.faces.modified).toEqual(new Map([[2, [5, 6]]]));
    expect(h.faces.deleted).toEqual([3]);
    expect(h.faces.added).toEqual([7]);
  });

  it('drops listed images outside the result; with none left the input is deleted', () => {
    const h = buildOperationHistory(
      { ...noLists, modified: [10, 2, 99, 98], edgeModified: [30, 2, 31, 97] },
      input([[10, [1]]], [[30, [3]]]),
      result([], [[31, 4]]),
      head,
    );
    expect(h.faces.deleted).toEqual([1]);
    expect(h.edges.modified).toEqual(new Map([[3, [4]]]));
  });

  it('sorts edges from faces in generated lists', () => {
    const h = buildOperationHistory(
      { ...noLists, generated: [10, 3, 21, 31, 99], edgeGenerated: [30, 3, 22, 32, 41] },
      input([[10, [1]]], [[30, [3]]]),
      result(
        [
          [10, 1],
          [21, 5],
          [22, 6],
          [23, 7],
        ],
        [
          [31, 8],
          [32, 9],
          [33, 10],
        ],
        [41],
      ),
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
      { ...noLists, edgeGenerated: [30, 1, 21] },
      input([], [[30, [3]]]),
      result([[21, 5]]),
      head,
    );
    expect(h.edges.deleted).toEqual([3]);
    expect(h.facesFromEdge).toEqual(new Map([[3, [5]]]));
  });

  it('skips a listed input it does not know, leaving its images added', () => {
    const h = buildOperationHistory(
      { ...noLists, modified: [77, 1, 21], generated: [78, 1, 21] },
      input([]),
      result([[21, 5]]),
      head,
    );
    expect(h.faces.modified.size).toBe(0);
    expect(h.facesFromFace.size).toBe(0);
    expect(h.faces.added).toEqual([5]);
  });

  it('leaves kept faces out of the generated maps', () => {
    const h = buildOperationHistory(
      { ...noLists, generated: [10, 1, 10] },
      input([[10, [1]]]),
      result([[10, 1]]),
      head,
    );
    expect(h.faces.kept).toEqual([1]);
    expect(h.facesFromFace.size).toBe(0);
  });

  it('treats an input listed as becoming only itself as kept', () => {
    const h = buildOperationHistory({ ...noLists, modified: [10, 1, 10] }, input([[10, [1]]]), result([[10, 1]]), head);
    expect(h.faces.kept).toEqual([1]);
    expect(h.faces.modified.size).toBe(0);
  });

  it('keeps a surviving input among its images when it also became something else', () => {
    const h = buildOperationHistory(
      { ...noLists, modified: [10, 2, 10, 21] },
      input([[10, [1]]]),
      result([
        [10, 1],
        [21, 5],
      ]),
      head,
    );
    expect(h.faces.kept).toEqual([]);
    expect(h.faces.modified).toEqual(new Map([[1, [1, 5]]]));
  });

  it('reports a face held the other way round as modified into its new key', () => {
    const h = buildOperationHistory(noLists, input([[10, [1]]]), result([[10, 2]]), head);
    expect(h.faces.kept).toEqual([]);
    expect(h.faces.modified).toEqual(new Map([[1, [2]]]));
    expect(h.faces.added).toEqual([]);
  });

  it('merges several inputs into one result', () => {
    const h = buildOperationHistory(
      { ...noLists, modified: [10, 1, 21, 11, 1, 21] },
      input([
        [10, [1]],
        [11, [2]],
      ]),
      result([[21, 5]]),
      head,
    );
    expect(h.faces.modified).toEqual(
      new Map([
        [1, [5]],
        [2, [5]],
      ]),
    );
  });

  it('refuses a listed hash that matches two kinds in the result', () => {
    const lists = { ...noLists, generated: [10, 1, 21] };
    const build = () => buildOperationHistory(lists, input([[10, [1]]]), result([[21, 5]], [[21, 6]]), head);
    expect(build).toThrow(NamingAdapterError);
    expect(build).toThrow(/several kinds/);
    expect(() => buildOperationHistory(lists, input([[10, [1]]]), result([[21, 5]], [], [21]), head)).toThrow(
      /several kinds/,
    );
  });

  it('allows a hash shared across kinds when nothing lists it', () => {
    const h = buildOperationHistory(
      noLists,
      input([[10, [1]]]),
      result(
        [
          [10, 1],
          [21, 5],
        ],
        [[21, 6]],
      ),
      head,
    );
    expect(h.faces.added).toEqual([5]);
    expect(h.edges.added).toEqual([6]);
  });
});
