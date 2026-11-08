import { describe, expect, it } from 'vitest';
import { cyclePolyline, detectRegions, type DetectedRegion, type Detection } from './detect';
import { drawn, loopText, SketchBuilder } from './fixtures';
import { matchRegions } from './match';
import { layUse } from './stretches';
import type { RegionRow, SolvedSketch, Use } from './types';

/** The sketch's regions as stored rows `s0`, `s1`, … in detection order. */
function storedFrom(sketch: SolvedSketch): RegionRow[] {
  return detectRegions(sketch).regions.map((r, i) => ({
    id: `s${i}`,
    loop: r.loop,
    holes: r.holes,
    origin: { detected: {} },
  }));
}

function row(id: string, loop: readonly Use[]): RegionRow {
  return { id, loop, holes: { set: [] }, origin: { detected: {} } };
}

function rowContaining(rows: RegionRow[], text: string): RegionRow {
  const found = rows.find((r) => loopText(r.loop).includes(text));
  if (!found) throw new Error(`no row uses ${text}`);
  return found;
}

function bySize(pieces: readonly { region: DetectedRegion }[]): number[] {
  return pieces.map((p) => Number(p.region.area.toFixed(6))).sort((a, b) => a - b);
}

const rectangle = (x1: number) => new SketchBuilder().rectangle('r', 0, 0, x1, 10);

describe('keeping ids', () => {
  it('keeps every region of an unchanged sketch', () => {
    const sketch = rectangle(10).circle('c', 10, 5, 3).build();
    const stored = storedFrom(sketch);
    const matching = matchRegions(detectRegions(sketch), stored);
    expect(matching.kept.map((k) => k.id).sort()).toEqual(stored.map((s) => s.id).sort());
    expect(matching.divided).toEqual([]);
    expect(matching.new).toEqual([]);
    expect(matching.unmatched).toEqual([]);
  });

  it('keeps a region when a value moves its curves', () => {
    const stored = storedFrom(rectangle(10).build());
    const matching = matchRegions(detectRegions(rectangle(30).build()), stored);
    expect(matching.kept.map((k) => k.id)).toEqual(['s0']);
  });

  it('measures overlap on current geometry, not on the stored shape', () => {
    const stored = storedFrom(rectangle(10).segment('m', [4, -2], [4, 12]).build());
    const moved = rectangle(10).segment('m', [9, -2], [9, 12]).build();
    const matching = matchRegions(detectRegions(moved), stored);
    expect(matching.kept).toHaveLength(2);
    const left = rowContaining(stored, 'rl:r4>r1');
    const kept = matching.kept.find((k) => k.id === left.id)!;
    expect(kept.region.area).toBeCloseTo(90, 8);
  });

  it('writes nothing to the table it reads', () => {
    const stored = storedFrom(rectangle(10).build());
    const before = JSON.stringify(stored);
    matchRegions(detectRegions(rectangle(10).segment('m', [4, -2], [4, 12]).build()), stored);
    expect(JSON.stringify(stored)).toBe(before);
  });
});

describe('divided regions', () => {
  it('finds a region divided, not new, when a line subdivides its boundary', () => {
    const stored = storedFrom(rectangle(10).build());
    const sketch = rectangle(10).segment('m', [4, -2], [4, 12]).build();
    const matching = matchRegions(detectRegions(sketch), stored);
    expect(matching.kept).toEqual([]);
    expect(matching.new).toEqual([]);
    expect(matching.divided).toHaveLength(1);
    expect(matching.divided[0]!.id).toBe('s0');
    expect(bySize(matching.divided[0]!.pieces)).toEqual([40, 60]);
  });

  it('signs each piece against the dividing curve from its sample point', () => {
    const stored = storedFrom(rectangle(10).build());
    const sketch = rectangle(10).segment('m', [4, -2], [4, 12]).build();
    const [divided] = matchRegions(detectRegions(sketch), stored).divided;
    const signs = divided!.pieces.map((p) => [Number(p.region.area.toFixed(6)), p.sides]);
    expect(signs).toContainEqual([40, [{ curve: drawn('m'), sign: 1 }]]);
    expect(signs).toContainEqual([60, [{ curve: drawn('m'), sign: -1 }]]);
    expect(divided!.pieces.every((p) => !p.paused)).toBe(true);
  });

  it('signs a piece only against the dividing curves it touches', () => {
    const stored = storedFrom(rectangle(12).build());
    const sketch = rectangle(12).segment('m', [3, -2], [3, 12]).segment('n', [8, -2], [8, 12]).build();
    const [divided] = matchRegions(detectRegions(sketch), stored).divided;
    const signs = Object.fromEntries(
      divided!.pieces.map((p) => [Math.round(p.region.area), p.sides.map((s) => s.sign)]),
    );
    expect(signs).toEqual({ 30: [1], 50: [-1, 1], 40: [-1] });
    const middle = divided!.pieces.find((p) => Math.round(p.region.area) === 50)!;
    expect(middle.sides.map((s) => s.curve)).toEqual([drawn('m'), drawn('n')]);
  });

  it('divides a rectangle by crossing lines into four pieces of it', () => {
    const stored = storedFrom(rectangle(10).build());
    const sketch = rectangle(10).segment('v', [5, -1], [5, 11]).segment('h', [-1, 3], [11, 3]).build();
    const [divided] = matchRegions(detectRegions(sketch), stored).divided;
    expect(bySize(divided!.pieces)).toEqual([15, 15, 35, 35]);
    expect(divided!.pieces.every((p) => p.sides.length === 2)).toBe(true);
  });

  it('tells a closed dividing curve by inside and outside', () => {
    const stored = storedFrom(rectangle(10).build());
    const sketch = rectangle(10).circle('c', 10, 5, 3).build();
    const matching = matchRegions(detectRegions(sketch), stored);
    expect(matching.divided).toHaveLength(1);
    const pieces = matching.divided[0]!.pieces;
    expect(pieces).toHaveLength(2);
    const lens = pieces.reduce((a, b) => (a.region.area < b.region.area ? a : b));
    const rest = pieces.reduce((a, b) => (a.region.area < b.region.area ? b : a));
    expect(lens.sides).toEqual([{ curve: drawn('c'), sign: -1 }]);
    expect(rest.sides).toEqual([{ curve: drawn('c'), sign: 1 }]);
    expect(matching.new).toHaveLength(1);
  });

  it("holds its hole's arcs as boundary, not as dividers, when a line cuts through", () => {
    const stored = storedFrom(rectangle(10).circle('c', 5, 5, 2).build());
    const ring = stored.find((s) => s.holes.set.length === 1)!;
    const sketch = rectangle(10).circle('c', 5, 5, 2).segment('m', [5, -1], [5, 11]).build();
    const matching = matchRegions(detectRegions(sketch), stored);
    const divided = matching.divided.find((d) => d.id === ring.id)!;
    expect(divided.pieces).toHaveLength(2);
    for (const piece of divided.pieces) expect(piece.dividers).toEqual([drawn('m')]);
  });
});

describe('roles and directions', () => {
  it('never overlaps a circle bounding a disc with the same circle as a hole', () => {
    const disc = storedFrom(new SketchBuilder().circle('c', 5, 5, 2).build());
    const sketch = rectangle(10).circle('c', 5, 5, 2).build();
    const matching = matchRegions(detectRegions(sketch), disc);
    expect(matching.kept.map((k) => k.region.holes.set.length)).toEqual([0]);
    expect(matching.new.map((n) => n.region.holes.set.length)).toEqual([1]);
  });

  it('never overlaps a use with its reverse', () => {
    const both = rectangle(10).point('p', 4, 0).point('q', 4, 10).line('m', 'p', 'q').build();
    const left = [rowContaining(storedFrom(both), 'rl:r4>r1')];
    const matching = matchRegions(detectRegions(both), left);
    expect(matching.kept).toHaveLength(1);
    expect(matching.new).toHaveLength(1);
    expect(matching.new[0]!.region.area).toBeCloseTo(60, 8);
  });

  it('reads a closed use against a contour wound the other way', () => {
    const key = { glyph: { text: 't', glyph: 0, contour: 0 } };
    const glyph = new SketchBuilder().add(
      key,
      {
        kind: 'contour',
        segments: [
          [
            [0, 0],
            [0, 10],
          ],
          [
            [0, 10],
            [10, 10],
          ],
          [
            [10, 10],
            [10, 0],
          ],
          [
            [10, 0],
            [0, 0],
          ],
        ],
      },
      { kind: 'none' },
    );
    const stored = storedFrom(glyph.build());
    const cut = glyph.segment('m', [5, -1], [5, 11]).build();
    const [divided] = matchRegions(detectRegions(cut), stored).divided;
    expect(divided!.pieces).toHaveLength(2);
  });
});

describe('the matching rule', () => {
  const loopRow = (id: string, ...texts: string[]) => {
    const whole = detectRegions(rectangle(10).build()).regions[0]!;
    return row(
      id,
      whole.loop.filter((_, i) => texts.includes(['b', 'r', 't', 'l'][i]!)),
    );
  };

  it('goes to the row sharing the most length', () => {
    const matching = matchRegions(detectRegions(rectangle(10).build()), [
      loopRow('one', 'b'),
      loopRow('two', 'r', 't'),
    ]);
    expect(matching.kept.map((k) => k.id)).toEqual(['two']);
    expect(matching.unmatched).toEqual(['one']);
  });

  it('resolves tied rows to nothing, whatever fraction each shared and wherever else they lead', () => {
    const sketch = rectangle(10).circle('far', 100, 5, 2).build();
    const [bottom, , top] = detectRegions(rectangle(10).build()).regions[0]!.loop;
    const elsewhere: Use = { closed: { curve: drawn('far') } };
    const matching = matchRegions(detectRegions(sketch), [row('diluted', [bottom!, elsewhere]), row('pure', [top!])]);
    expect(matching.new.map((n) => n.region.loop.length).sort()).toEqual([1, 4]);
    expect(matching.unmatched).toEqual(['diluted', 'pure']);
    expect(matching.kept).toEqual([]);
  });

  it('resolves both halves to nothing and the whole to new when lengths tie', () => {
    const [a, b] = storedFrom(rectangle(10).segment('m', [5, -2], [5, 12]).build());
    const matching = matchRegions(detectRegions(rectangle(10).build()), [a!, b!]);
    expect(matching.kept).toEqual([]);
    expect(matching.unmatched.sort()).toEqual([a!.id, b!.id].sort());
    expect(matching.new).toHaveLength(1);
  });

  it('treats lengths equal but for rounding as a tie', () => {
    const third = 10 / 3;
    const halves = new SketchBuilder()
      .rectangle('r', 0, 0, third * 2, third)
      .segment('m', [third, -1], [third, 5])
      .build();
    const whole = detectRegions(new SketchBuilder().rectangle('r', 0, 0, third * 2, third).build());
    const matching = matchRegions(whole, storedFrom(halves));
    expect(matching.kept).toEqual([]);
    expect(matching.new).toHaveLength(1);
  });

  it('calls a region sharing no length new, identified by its sorted uses', () => {
    const stored = storedFrom(rectangle(10).build());
    const sketch = rectangle(10).circle('far', 100, 5, 2).build();
    const matching = matchRegions(detectRegions(sketch), stored);
    expect(matching.kept.map((k) => k.id)).toEqual(['s0']);
    expect(matching.new).toHaveLength(1);
    expect(matching.new[0]!.identity).toEqual({ set: [{ closed: { curve: drawn('far') } }] });
  });

  it('calls a touching region new when it shares only a point', () => {
    const stored = storedFrom(rectangle(10).build());
    const sketch = rectangle(10).circle('c', 13, 5, 3).build();
    const matching = matchRegions(detectRegions(sketch), stored);
    expect(matching.kept.map((k) => k.id)).toEqual(['s0']);
    expect(matching.new).toHaveLength(1);
  });
});

describe('an island drawn inside a stored region', () => {
  it('makes the island a piece of the region around it, so the area stays', () => {
    const stored = storedFrom(rectangle(10).build());
    const sketch = rectangle(10).circle('c', 5, 5, 2).build();
    const matching = matchRegions(detectRegions(sketch), stored);
    expect(matching.kept).toEqual([]);
    expect(matching.new).toEqual([]);
    expect(matching.divided.map((d) => d.id)).toEqual(['s0']);
    const pieces = matching.divided[0]!.pieces;
    expect(pieces.reduce((sum, p) => sum + p.region.area, 0)).toBeCloseTo(100, 8);
    const disc = pieces.find((p) => p.region.holes.set.length === 0)!;
    const ring = pieces.find((p) => p.region.holes.set.length === 1)!;
    expect(disc.sides).toEqual([{ curve: drawn('c'), sign: -1 }]);
    expect(ring.sides).toEqual([{ curve: drawn('c'), sign: 1 }]);
  });

  it('leaves the disc new when the region already had that hole', () => {
    const sketch = rectangle(10).circle('c', 5, 5, 2).build();
    const ring = storedFrom(sketch).filter((s) => s.holes.set.length === 1);
    const matching = matchRegions(detectRegions(sketch), ring);
    expect(matching.kept.map((k) => k.id)).toEqual(ring.map((r) => r.id));
    expect(matching.new).toHaveLength(1);
  });

  it('makes every region nested in the new hole a piece', () => {
    const stored = storedFrom(rectangle(10).build());
    const sketch = rectangle(10).circle('c', 5, 5, 3).circle('d', 5, 5, 1).build();
    const matching = matchRegions(detectRegions(sketch), stored);
    expect(matching.new).toEqual([]);
    expect(matching.divided).toHaveLength(1);
    const pieces = matching.divided[0]!.pieces;
    expect(pieces).toHaveLength(3);
    expect(pieces.reduce((sum, p) => sum + p.region.area, 0)).toBeCloseTo(100, 8);
  });

  it('makes regions that fill the hole together pieces, signed against each curve', () => {
    const stored = storedFrom(rectangle(10).build());
    const sketch = rectangle(10).circle('c', 5, 5, 3).segment('m', [5, 1], [5, 9]).build();
    const matching = matchRegions(detectRegions(sketch), stored);
    expect(matching.new).toEqual([]);
    const pieces = matching.divided[0]!.pieces;
    expect(pieces).toHaveLength(3);
    expect(pieces.reduce((sum, p) => sum + p.region.area, 0)).toBeCloseTo(100, 8);
    const halves = pieces.filter((p) => p.region.holes.set.length === 0);
    expect(halves.map((p) => p.sides.map((s) => s.sign)).sort()).toEqual([
      [-1, -1],
      [-1, 1],
    ]);
  });

  it('gives none of the hole when one region inside shares with a stored row', () => {
    const inner = storedFrom(new SketchBuilder().circle('d', 5, 5, 1).build());
    const stored = [...storedFrom(rectangle(10).build()), { ...inner[0]!, id: 'disc' }];
    const sketch = rectangle(10).circle('c', 5, 5, 3).circle('d', 5, 5, 1).build();
    const matching = matchRegions(detectRegions(sketch), stored);
    expect(matching.divided).toEqual([]);
    expect(matching.kept.map((k) => k.id).sort()).toEqual(['disc', 's0']);
    expect(matching.new).toHaveLength(1);
  });

  it('gives the island to a divided region through the piece around it', () => {
    const stored = storedFrom(rectangle(20).build());
    const sketch = rectangle(20).segment('m', [15, -1], [15, 11]).circle('c', 6, 5, 2).build();
    const [divided] = matchRegions(detectRegions(sketch), stored).divided;
    expect(divided!.pieces).toHaveLength(3);
  });

  it('gives nothing to a host that tied', () => {
    const [a, b] = storedFrom(rectangle(10).segment('m', [5, -2], [5, 12]).build());
    const sketch = rectangle(10).circle('c', 5, 5, 2).build();
    const matching = matchRegions(detectRegions(sketch), [a!, b!]);
    expect(matching.divided).toEqual([]);
    expect(matching.new).toHaveLength(2);
  });
});

describe('ends missing from the current solve', () => {
  const stored = storedFrom(rectangle(10).segment('m', [4, -2], [4, 12]).build());

  it('gives no length to a use whose crossing is gone', () => {
    const left = rowContaining(stored, 'rl:r4>r1');
    const gone = rectangle(10).segment('m', [4, -2], [4, 5]).build();
    const matching = matchRegions(detectRegions(gone), [left]);
    // Only the side and the stretch up to the surviving crossing count.
    expect(matching.shared[0]!.get(0)).toBeCloseTo(14, 8);
  });

  it('gives no length to a use whose crossing number no longer exists', () => {
    const end = { cross: { with: drawn('m'), sense: 1 as const, k: 7, kWith: 7 } };
    const rb = drawn('rb');
    const stale: Use = { open: { curve: rb, from: { point: { id: 'r1' } }, to: end, reversed: false } };
    const sketch = rectangle(10).segment('m', [4, -2], [4, 12]).build();
    const matching = matchRegions(detectRegions(sketch), [row('x', [stale])]);
    expect(matching.unmatched).toEqual(['x']);
  });

  it('gives no length to a use on a curve that is gone', () => {
    const lost: Use = { closed: { curve: drawn('nothing') } };
    const matching = matchRegions(detectRegions(rectangle(10).build()), [row('x', [lost])]);
    expect(matching.unmatched).toEqual(['x']);
    expect(matching.new).toHaveLength(1);
  });

  it('gives no length to a use whose point left the curve', () => {
    const b = new SketchBuilder().rectangle('r', 0, 0, 10, 10).point('away', 5, 50);
    const stray: Use = {
      open: {
        curve: drawn('rb'),
        from: { point: { id: 'r1' } },
        to: { point: { id: 'away' } },
        reversed: false,
      },
    };
    const matching = matchRegions(detectRegions(b.build()), [row('x', [stray])]);
    expect(matching.unmatched).toEqual(['x']);
  });

  it('gives no length to a point that lies on the curve but is not its own', () => {
    const b = new SketchBuilder().rectangle('r', 0, 0, 10, 10).point('on', 5, 0);
    const half: Use = {
      open: {
        curve: drawn('rb'),
        from: { point: { id: 'r1' } },
        to: { point: { id: 'on' } },
        reversed: false,
      },
    };
    const matching = matchRegions(detectRegions(b.build()), [row('x', [half])]);
    expect(matching.unmatched).toEqual(['x']);
  });
});

describe('a dividing line falling short', () => {
  const full = rectangle(10).segment('m', [4, -2], [4, 12]).build();
  const short = rectangle(10).segment('m', [4, -2], [4, 5]).build();

  it('resolves the region that lost more of its boundary to nothing, not to the whole', () => {
    const stored = storedFrom(full);
    const left = rowContaining(stored, 'rl:r4>r1');
    const right = stored.find((s) => s !== left)!;
    const matching = matchRegions(detectRegions(short), stored);
    expect(matching.kept.map((k) => k.id)).toEqual([right.id]);
    expect(matching.kept[0]!.region.area).toBeCloseTo(100, 8);
    expect(matching.unmatched).toEqual([left.id]);
    expect(matching.new).toEqual([]);
  });

  it('finds both again once the line reaches across', () => {
    const stored = storedFrom(full);
    const matching = matchRegions(detectRegions(full), stored);
    expect(matching.unmatched).toEqual([]);
    expect(matching.kept).toHaveLength(2);
  });
});

describe('a value pushing curves across each other', () => {
  it('finds a circle pushed across a rectangle divided along the side', () => {
    const stored = storedFrom(rectangle(10).circle('c', 15, 5, 3).build());
    const rect = stored.find((s) => s.loop.length === 4)!;
    const disc = stored.find((s) => s.loop.length === 1)!;
    const matching = matchRegions(detectRegions(rectangle(10).circle('c', 10, 5, 3).build()), stored);
    expect(matching.new).toEqual([]);
    expect(matching.unmatched).toEqual([]);
    expect(matching.kept.map((k) => k.id)).toEqual([rect.id]);
    expect(matching.divided.map((d) => d.id)).toEqual([disc.id]);
    const pieces = matching.divided[0]!.pieces;
    const sides = pieces.map((p) => p.sides);
    expect(sides).toContainEqual([{ curve: drawn('rr'), sign: 1 }]);
    expect(sides).toContainEqual([{ curve: drawn('rr'), sign: -1 }]);
  });

  it('counts crossings against live descendants when one more appears', () => {
    const one = rectangle(12).segment('w1', [3, -1], [3, 11], 'w').build();
    const stored = storedFrom(one);
    const two = rectangle(12).segment('w1', [3, -1], [3, 11], 'w').segment('w2', [8, -1], [8, 11], 'w').build();
    const matching = matchRegions(detectRegions(two), stored);
    const left = rowContaining(stored, 'rl:r4>r1');
    expect(matching.kept.map((k) => k.id)).toContain(left.id);
  });

  it('shifts both numbers when a crossing appears earlier along both curves, a known limit', () => {
    const stored = storedFrom(rectangle(12).segment('w1', [8, -1], [8, 11], 'w').build());
    const right = rowContaining(stored, 'rr:r2>r3');
    const use = right.loop.find((u) => loopText([u])[0] === 'rb:x(w,+0)>r2')!;
    const two = rectangle(12).segment('w2', [3, -1], [3, 11], 'w').segment('w1', [8, -1], [8, 11], 'w').build();
    const { arrangement } = detectRegions(two);
    expect(layUse(arrangement, use, 'outer')!.length).toBeCloseTo(9, 8);
  });

  it('gives no length when a crossing appears earlier along one curve only', () => {
    const stored = storedFrom(rectangle(12).segment('w1', [8, -1], [8, 11], 'w').build());
    const right = rowContaining(stored, 'rr:r2>r3');
    const use = right.loop.find((u) => loopText([u])[0] === 'rb:x(w,+0)>r2')!;
    const two = rectangle(12).segment('w1', [8, -1], [8, 11], 'w').segment('w2', [3, -1], [3, 11], 'w').build();
    const { arrangement } = detectRegions(two);
    expect(layUse(arrangement, use, 'outer')).toBeNull();
  });

  it('does not shift k for a crossing of the other sense', () => {
    const stored = storedFrom(rectangle(12).segment('w1', [8, -1], [8, 11], 'w').build());
    const right = rowContaining(stored, 'rr:r2>r3');
    const use = right.loop.find((u) => loopText([u])[0] === 'rb:x(w,+0)>r2')!;
    const two = rectangle(12).segment('w1', [8, -1], [8, 11], 'w').segment('w2', [3, 11], [3, -1], 'w').build();
    const { arrangement } = detectRegions(two);
    expect(layUse(arrangement, use, 'outer')!.length).toBeCloseTo(4, 8);
  });
});

describe('two crossings of one sense on a closed curve', () => {
  /** Turn of a region's middle from the major axis, in degrees from -180 to 180. */
  function offAxis(detection: Detection, region: DetectedRegion, major: number): number {
    const line = cyclePolyline(detection.arrangement, region.outer, 1);
    const x = line.reduce((sum, p) => sum + p[0], 0);
    const y = line.reduce((sum, p) => sum + p[1], 0);
    const degrees = (Math.atan2(y, x) * 180) / Math.PI - major;
    return ((((degrees + 180) % 360) + 360) % 360) - 180;
  }

  const turned = (degrees: number) => {
    const a = (degrees * Math.PI) / 180;
    return new SketchBuilder()
      .circle('c', 0, 0, 5)
      .add(
        drawn('e'),
        {
          kind: 'ellipse',
          center: [0, 0],
          majorEnd: [9 * Math.cos(a), 9 * Math.sin(a)],
          minorRadius: 2,
        },
        { kind: 'none' },
      )
      .build();
  };

  it('keeps every region of an unchanged circle and ellipse', () => {
    const stored = storedFrom(turned(30));
    const matching = matchRegions(detectRegions(turned(30)), stored);
    expect(matching.kept).toHaveLength(5);
    expect(matching.new).toEqual([]);
    for (const { id, region } of matching.kept) {
      expect(region.loop).toEqual(stored.find((s) => s.id === id)!.loop);
    }
  });

  it('keeps them while no crossing passes the circle origin', () => {
    const stored = storedFrom(turned(30));
    expect(matchRegions(detectRegions(turned(25)), stored).kept).toHaveLength(5);
    expect(matchRegions(detectRegions(turned(100)), stored).kept).toHaveLength(5);
  });

  it('pauses when the numbers along the two curves stop agreeing', () => {
    const stored = storedFrom(turned(30));
    for (const degrees of [10, 170, 200]) {
      const matching = matchRegions(detectRegions(turned(degrees)), stored);
      expect(matching.kept).toEqual([]);
      expect(matching.divided).toEqual([]);
      expect(matching.unmatched.sort()).toEqual(stored.map((s) => s.id).sort());
      expect(matching.new).toHaveLength(5);
    }
  });

  it('swaps unseen when one edit passes both origins, a known limit', () => {
    const stored = storedFrom(turned(30));
    const first = detectRegions(turned(30));
    const index = first.regions.findIndex((r) => {
      const off = offAxis(first, r, 30);
      return off > 80 && off < 100 && r.area > 15 && r.area < 25;
    });
    // The same ellipse as at -25 degrees, its origin at the other end of the axis.
    const later = detectRegions(turned(155));
    const { kept } = matchRegions(later, stored);
    expect(kept).toHaveLength(5);
    const landed = kept.find((k) => k.id === stored[index]!.id)!;
    expect(offAxis(later, landed.region, -25)).toBeCloseTo(-90, -1);
  });

  it('still lays the crossing of its sense when it is the only one', () => {
    const sketch = rectangle(10).circle('c', 10, 5, 3).build();
    const { arrangement, regions } = detectRegions(sketch);
    const uses = regions.flatMap((r) => [...r.loop]);
    expect(uses.every((u) => layUse(arrangement, u, 'outer') !== null)).toBe(true);
  });

  it('keeps a stored disc on its exact pieces, having no crossing to number', () => {
    const away = new SketchBuilder().circle('c', 0, 0, 5).build();
    const stored = storedFrom(away);
    const matching = matchRegions(detectRegions(turned(30)), stored);
    expect(matching.divided.map((d) => d.id)).toEqual(stored.map((s) => s.id));
    expect(matching.divided[0]!.pieces).toHaveLength(3);
    expect(matching.new).toHaveLength(2);
  });
});

describe('two crescents of intersecting circles', () => {
  const circles = (x: number, y = 0) => new SketchBuilder().circle('a', 0, 0, 5).circle('b', x, y, 5).build();

  function byArea(sketch: SolvedSketch, stored: RegionRow[]) {
    const matching = matchRegions(detectRegions(sketch), stored);
    return matching.kept.map((k) => ({ id: k.id, loop: loopText(k.region.loop) }));
  }

  it('keeps both crescents and the lens as the circles slide', () => {
    const stored = storedFrom(circles(6));
    const kept = byArea(circles(7), stored);
    expect(kept).toHaveLength(3);
    for (const { id, loop } of kept) {
      expect(loop).toEqual(loopText(stored.find((s) => s.id === id)!.loop));
    }
  });

  it('resolves all three to nothing when the circles part', () => {
    const stored = storedFrom(circles(6));
    const matching = matchRegions(detectRegions(circles(20)), stored);
    expect(matching.unmatched.sort()).toEqual(stored.map((s) => s.id).sort());
    expect(matching.new).toHaveLength(2);
  });

  it('finds discs of different sizes divided when pushed together', () => {
    const apart = new SketchBuilder().circle('a', 0, 0, 5).circle('b', 20, 0, 4).build();
    const stored = storedFrom(apart);
    const small = rowContaining(stored, 'b:closed');
    const large = rowContaining(stored, 'a:closed');
    const near = new SketchBuilder().circle('a', 0, 0, 5).circle('b', 6, 0, 4).build();
    const matching = matchRegions(detectRegions(near), stored);
    expect(matching.new).toEqual([]);
    expect(matching.kept.map((k) => k.id)).toEqual([large.id]);
    expect(matching.divided.map((d) => d.id)).toEqual([small.id]);
    expect(matching.divided[0]!.pieces).toHaveLength(2);
  });

  it('resolves equal discs to nothing when the lens between them ties', () => {
    const stored = storedFrom(circles(20));
    const matching = matchRegions(detectRegions(circles(6)), stored);
    expect(matching.kept).toEqual([]);
    expect(matching.divided).toEqual([]);
    expect(matching.unmatched.sort()).toEqual(stored.map((s) => s.id).sort());
    expect(matching.new).toHaveLength(3);
  });

  it("keeps all three ids when a crossing turns past a circle's origin", () => {
    const stored = storedFrom(circles(6));
    for (const degrees of [70, 130, 200, 290]) {
      const angle = (degrees * Math.PI) / 180;
      const turned = circles(6 * Math.cos(angle), 6 * Math.sin(angle));
      const { kept } = matchRegions(detectRegions(turned), stored);
      expect(kept).toHaveLength(3);
      for (const { id, loop } of byArea(turned, stored)) {
        expect(loop).toEqual(loopText(stored.find((s) => s.id === id)!.loop));
      }
    }
  });
});
