import { describe, expect, it } from 'vitest';
import { detectRegions } from './detect';
import { resolveRegion, writePickedRegion, writeRegionFates } from './fates';
import { drawn, loopText, SketchBuilder } from './fixtures';
import { matchRegions } from './match';
import type { CurveKey, RegionRow, RegionTable, SolvedSketch } from './types';

function tableFrom(sketch: SolvedSketch): RegionTable {
  const regions = detectRegions(sketch).regions.map((r, i): RegionRow => ({
    id: `s${i}`,
    loop: r.loop,
    holes: r.holes,
    origin: { detected: {} },
  }));
  return { regions, retired: [] };
}

function ids(prefix = 'n'): () => string {
  let next = 0;
  return () => `${prefix}${next++}`;
}

function write(table: RegionTable, sketch: SolvedSketch, commandCurves: CurveKey[]): RegionTable {
  return writeRegionFates(table, detectRegions(sketch), { commandCurves, newRegionId: ids() });
}

const rectangle = (x1 = 10) => new SketchBuilder().rectangle('r', 0, 0, x1, 10);
const halves = () => rectangle().segment('m', [5, -2], [5, 12]);

describe('split', () => {
  it('retires a region the command divides and gives its pieces new ids', () => {
    const table = tableFrom(rectangle().build());
    const after = write(table, halves().build(), [drawn('m')]);
    expect(after.regions.map((r) => r.id)).toEqual(['n0', 'n1']);
    expect(after.regions.every((r) => 'from' in r.origin && r.origin.from.id === 's0')).toBe(true);
    expect(after.retired).toEqual([
      {
        id: 's0',
        was: {
          region: {
            loop: table.regions[0]!.loop,
            holes: table.regions[0]!.holes,
            origin: { detected: {} },
          },
        },
        fate: { split: {} },
      },
    ]);
  });

  it("keeps the retired region's extensions and unknown fields", () => {
    const plain = tableFrom(rectangle().build());
    const row = { ...plain.regions[0]!, extensions: { vendor: { annotation: 'a' } }, future: 1 } as RegionRow;
    const after = write({ regions: [row], retired: [] }, halves().build(), [drawn('m')]);
    const was = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'));
    expect(after.retired[0]?.was).toEqual({ region: was });
  });

  it('puts the pieces where the region stood in the table', () => {
    const before = rectangle().circle('far', 100, 5, 2).circle('near', 120, 5, 2).build();
    const table = tableFrom(before);
    const square = table.regions.findIndex((r) => r.loop.length === 4);
    const after = write(
      table,
      rectangle().circle('far', 100, 5, 2).circle('near', 120, 5, 2).segment('m', [5, -2], [5, 12]).build(),
      [drawn('m')],
    );
    expect(after.regions).toHaveLength(4);
    expect(after.regions[square]!.id).toBe('n0');
    expect(after.regions[square + 1]!.id).toBe('n1');
  });

  it('splits a region around an island the command draws', () => {
    const table = tableFrom(rectangle().build());
    const after = write(table, rectangle().circle('c', 5, 5, 2).build(), [drawn('c')]);
    expect(after.regions.map((r) => r.id)).toEqual(['n0', 'n1']);
    expect(after.retired.map((r) => [r.id, r.fate])).toEqual([['s0', { split: {} }]]);
  });

  it('splits a region around islands that fill a new hole together', () => {
    const table = tableFrom(rectangle().build());
    const sketch = rectangle().circle('c', 5, 5, 2).segment('m', [5, 2], [5, 8]).build();
    const after = write(table, sketch, [drawn('c'), drawn('m')]);
    expect(after.regions.map((r) => r.id)).toEqual(['n0', 'n1', 'n2']);
  });

  it('puts the pieces in order of their sorted uses', () => {
    const table = tableFrom(rectangle().build());
    const detection = detectRegions(halves().build());
    const after = writeRegionFates(table, detection, {
      commandCurves: [drawn('m')],
      newRegionId: ids(),
    });
    expect(after.regions.map((r) => r.loop)).toEqual(detection.regions.map((r) => r.loop));
  });

  it('leaves a split no command curve takes part in', () => {
    const table = tableFrom(rectangle().build());
    const after = write(table, halves().build(), [drawn('other')]);
    expect(after).toEqual(table);
  });
});

describe('merge', () => {
  it('keeps the earlier id on a tie and retires the other as merged into it', () => {
    const table = tableFrom(halves().build());
    const after = write(table, rectangle().build(), [drawn('m')]);
    expect(after.regions.map((r) => r.id)).toEqual(['s0']);
    expect(loopText(after.regions[0]!.loop)).toEqual(['rb:r1>r2', 'rr:r2>r3', 'rt:r3>r4', 'rl:r4>r1']);
    expect(after.retired).toHaveLength(1);
    expect(after.retired[0]!.id).toBe('s1');
    expect(after.retired[0]!.fate).toEqual({ merged: { into: { id: 's0' } } });
    expect('region' in after.retired[0]!.was).toBe(true);
  });

  it('merges a region into the first of two heirs sharing equal length', () => {
    const sketch = halves().build();
    const table = tableFrom(sketch);
    const bottom = detectRegions(rectangle().build()).regions[0]!.loop[0]!;
    const across: RegionRow = {
      id: 'across',
      loop: [bottom],
      holes: { set: [] },
      origin: { detected: {} },
    };
    const after = write({ ...table, regions: [...table.regions, across] }, sketch, [drawn('rb')]);
    expect(after.retired.map((r) => [r.id, r.fate])).toEqual([['across', { merged: { into: { id: 's0' } } }]]);
  });

  it('keeps the id of the region sharing most when they are not equal', () => {
    const outline = () =>
      new SketchBuilder()
        .point('a', 0, 0)
        .point('p', 2, 0)
        .point('b', 10, 0)
        .point('c', 10, 10)
        .point('q', 2, 10)
        .point('d', 0, 10)
        .line('b1', 'a', 'p')
        .line('b2', 'p', 'b')
        .line('e', 'b', 'c')
        .line('t2', 'c', 'q')
        .line('t1', 'q', 'd')
        .line('w', 'd', 'a');
    const table = tableFrom(outline().line('m', 'p', 'q').build());
    const wide = table.regions.find((r) => loopText(r.loop).includes('e:b>c'))!;
    const after = write(table, outline().build(), [drawn('m')]);
    expect(after.regions.map((r) => r.id)).toEqual([wide.id]);
  });

  it('counts nothing of a use that ended at the removed curve', () => {
    const table = tableFrom(rectangle().segment('m', [2, -2], [2, 12]).build());
    const whole = detectRegions(rectangle().build());
    const shares = [...matchRegions(whole, table.regions).shared[0]!.values()];
    expect(shares).toEqual([10, 10]);
  });

  it('merges into a piece when the same command divides the heir', () => {
    const table = tableFrom(halves().build());
    const sketch = rectangle().segment('h', [-1, 5], [11, 5]).build();
    const after = write(table, sketch, [drawn('m'), drawn('h')]);
    const merged = after.retired.find((r) => 'merged' in r.fate);
    const split = after.retired.find((r) => 'split' in r.fate);
    expect(split).toBeDefined();
    expect(merged).toBeDefined();
    const into = 'merged' in merged!.fate ? merged!.fate.merged.into.id : '';
    expect(after.regions.map((r) => r.id)).toContain(into);
  });
});

describe('delete', () => {
  it('retires a region whose boundary is gone as deleted', () => {
    const table = tableFrom(rectangle().build());
    const sketch = new SketchBuilder()
      .point('r1', 0, 0)
      .point('r2', 10, 0)
      .point('r3', 10, 10)
      .point('r4', 0, 10)
      .line('rb', 'r1', 'r2')
      .line('rr', 'r2', 'r3')
      .line('rt', 'r3', 'r4')
      .build();
    const after = write(table, sketch, [drawn('rl')]);
    expect(after.regions).toEqual([]);
    expect(after.retired.map((r) => [r.id, r.fate])).toEqual([['s0', { deleted: {} }]]);
  });

  it('leaves an unmatched region no command curve touches', () => {
    const table = tableFrom(rectangle().circle('c', 50, 0, 2).build());
    const sketch = rectangle().build();
    const disc = table.regions.find((r) => r.loop.length === 1)!;
    const after = write(table, sketch, [drawn('other')]);
    expect(after.regions.map((r) => r.id)).toContain(disc.id);
    expect(after.retired).toEqual([]);
  });
});

describe('what stays as it is', () => {
  it('keeps the rows of a circle and an ellipse a command leaves unchanged', () => {
    const sketch = new SketchBuilder()
      .circle('c', 0, 0, 5)
      .add(drawn('e'), { kind: 'ellipse', center: [0, 0], majorEnd: [9, 0], minorRadius: 2 }, { kind: 'none' })
      .build();
    const table = tableFrom(sketch);
    expect(table.regions).toHaveLength(5);
    expect(write(table, sketch, [drawn('e')])).toEqual(table);
  });

  it('writes no fate without a boundary curve in the command', () => {
    const table = tableFrom(halves().build());
    expect(write(table, rectangle().build(), [])).toEqual(table);
    const whole = tableFrom(rectangle().build());
    expect(write(whole, halves().build(), [])).toEqual(whole);
  });

  it('does not write a split a value produced when an unrelated curve is added', () => {
    const table = tableFrom(rectangle().segment('m', [5, -2], [5, 5]).build());
    const sketch = halves().circle('far', 100, 5, 2).build();
    expect(write(table, sketch, [drawn('far')])).toEqual(table);
  });

  it('does not write new regions', () => {
    const table = tableFrom(rectangle().build());
    const after = write(table, rectangle().circle('far', 100, 5, 2).build(), [drawn('far')]);
    expect(after).toEqual(table);
  });

  it("refreshes the boundary of a kept region the command's curve joins", () => {
    const table = tableFrom(rectangle().build());
    const corner = rectangle().point('a', 10, 8).point('b', 8, 10).line('cut', 'a', 'b').build();
    const after = write(table, corner, [drawn('cut')]);
    expect(after.regions.map((r) => r.id)).toEqual(['n0', 'n1']);
    expect(after.retired.map((r) => r.id)).toEqual(['s0']);
  });

  it('keeps the original retired rows', () => {
    const retired = [{ id: 'crv_old', was: { curve: { kind: 'line' } }, fate: { deleted: {} } }];
    const table = { ...tableFrom(rectangle().build()), retired };
    const after = write(table, halves().build(), [drawn('m')]);
    expect(after.retired[0]).toEqual(retired[0]);
    expect(after.retired).toHaveLength(2);
  });
});

describe('picking a new region', () => {
  it('writes it in the same command with a detected origin', () => {
    const table = tableFrom(rectangle().build());
    const detection = detectRegions(rectangle().circle('far', 100, 5, 2).build());
    const [fresh] = matchRegions(detection, table.regions).new;
    const after = writePickedRegion(table, fresh!.region, 'picked');
    expect(after.regions.map((r) => r.id)).toEqual(['s0', 'picked']);
    expect(after.regions[1]!.origin).toEqual({ detected: {} });
    expect(matchRegions(detection, after.regions).new).toEqual([]);
  });
});

describe('resolving region ids', () => {
  it('resolves a kept region to itself and an unmatched one to nothing', () => {
    const table = tableFrom(rectangle().segment('m', [4, -2], [4, 12]).build());
    const short = rectangle().segment('m', [4, -2], [4, 5]).build();
    const matching = matchRegions(detectRegions(short), table.regions);
    const kept = matching.kept[0]!;
    const unmatched = matching.unmatched[0]!;
    expect(resolveRegion(kept.id, table, matching)).toEqual([kept.region]);
    expect(resolveRegion(unmatched, table, matching)).toEqual([]);
  });

  it('resolves a region divided at build time to all its pieces', () => {
    const table = tableFrom(rectangle().build());
    const matching = matchRegions(detectRegions(halves().build()), table.regions);
    expect(resolveRegion('s0', table, matching)).toHaveLength(2);
  });

  it('resolves a split region alike, through its pieces', () => {
    const before = tableFrom(rectangle().build());
    const detection = detectRegions(halves().build());
    const after = writeRegionFates(before, detection, {
      commandCurves: [drawn('m')],
      newRegionId: ids(),
    });
    const matching = matchRegions(detection, after.regions);
    const atBuild = resolveRegion('s0', before, matchRegions(detection, before.regions));
    expect(resolveRegion('s0', after, matching).map((r) => r.area)).toEqual(atBuild.map((r) => r.area));
  });

  it('follows a merge to the region it merged into, and on through later merges', () => {
    const table = tableFrom(halves().build());
    const whole = detectRegions(rectangle().build());
    const merged = writeRegionFates(table, whole, { commandCurves: [drawn('m')] });
    const matching = matchRegions(whole, merged.regions);
    expect(resolveRegion('s1', merged, matching)).toEqual(resolveRegion('s0', merged, matching));
    expect(resolveRegion('s1', merged, matching)).toHaveLength(1);
  });

  it('resolves a deleted or unknown id to nothing', () => {
    const table = tableFrom(rectangle().build());
    const open = new SketchBuilder().segment('rb', [0, 0], [10, 0]).build();
    const detection = detectRegions(open);
    const after = writeRegionFates(table, detection, { commandCurves: [drawn('rl')] });
    const matching = matchRegions(detection, after.regions);
    expect(resolveRegion('s0', after, matching)).toEqual([]);
    expect(resolveRegion('nothing', after, matching)).toEqual([]);
  });
});
