import { describe, expect, it } from 'vitest';
import { canonicalBytes } from '../canonical';
import { compareBytes, readSet } from '../collections';
import { canonicalStart, detectRegions, locateInCycle } from './detect';
import { drawn, loopText, SketchBuilder, useText } from './fixtures';
import type { CurveShape, SolvedSketch, Use, Vec2 } from './types';

function regions(sketch: SolvedSketch) {
  return detectRegions(sketch).regions;
}

function loops(sketch: SolvedSketch): string[][] {
  return regions(sketch).map((r) => loopText(r.loop));
}

/** All the uses of all outer loops, as text. */
function outerUses(sketch: SolvedSketch): string[] {
  return loops(sketch).flat();
}

function areas(sketch: SolvedSketch): number[] {
  return regions(sketch)
    .map((r) => Number(r.area.toFixed(6)))
    .sort((a, b) => a - b);
}

describe('single loops', () => {
  it('walks a rectangle counter-clockwise from the smallest curve', () => {
    const sketch = new SketchBuilder().rectangle('r', 0, 0, 10, 5).build();
    expect(loops(sketch)).toEqual([['rb:r1>r2', 'rr:r2>r3', 'rt:r3>r4', 'rl:r4>r1']]);
    expect(areas(sketch)).toEqual([50]);
  });

  it('marks a line walked against its direction as reversed', () => {
    const sketch = new SketchBuilder()
      .point('a', 0, 0)
      .point('b', 0, 5)
      .point('c', 10, 5)
      .point('d', 10, 0)
      .line('l1', 'a', 'b')
      .line('l2', 'b', 'c')
      .line('l3', 'c', 'd')
      .line('l4', 'd', 'a')
      .build();
    expect(loops(sketch)).toEqual([['l1:b<a', 'l4:a<d', 'l3:d<c', 'l2:c<b']]);
  });

  it('gives a whole circle a closed use', () => {
    const sketch = new SketchBuilder().circle('c', 0, 0, 2).build();
    expect(loops(sketch)).toEqual([['c:closed']]);
    expect(areas(sketch)).toEqual([Number((Math.PI * 4).toFixed(6))]);
  });

  it('closes a D of a line and an arc', () => {
    const sketch = new SketchBuilder()
      .point('a', 0, -3)
      .point('b', 0, 3)
      .line('l', 'b', 'a')
      .arc('k', [0, 0], 'a', 'b')
      .build();
    expect(loops(sketch)).toEqual([['k:a>b', 'l:b>a']]);
    expect(areas(sketch)).toEqual([Number(((Math.PI * 9) / 2).toFixed(6))]);
  });

  it('finds nothing in an open curve and drops dangling lines', () => {
    expect(regions(new SketchBuilder().segment('l', [0, 0], [4, 4]).build())).toEqual([]);
    const sketch = new SketchBuilder().rectangle('r', 0, 0, 10, 10).point('tip', 5, 5).line('d', 'r1', 'tip').build();
    expect(loops(sketch)).toEqual([['rb:r1>r2', 'rr:r2>r3', 'rt:r3>r4', 'rl:r4>r1']]);
  });

  it('skips curves with no extent', () => {
    const b = new SketchBuilder().point('a', 1, 1).line('l', 'a', 'a').circle('c', 0, 0, 0);
    expect(regions(b.build())).toEqual([]);
  });
});

describe('holes', () => {
  it('holds a circle inside a rectangle as a clockwise hole and a disc of its own', () => {
    const sketch = new SketchBuilder().rectangle('r', 0, 0, 10, 10).circle('c', 5, 5, 2).build();
    const found = regions(sketch);
    expect(found).toHaveLength(2);
    const ring = found.find((r) => r.holes.set.length === 1)!;
    const disc = found.find((r) => r.holes.set.length === 0)!;
    expect(loopText(ring.holes.set[0]!)).toEqual(['c:closed']);
    expect(ring.inner[0]!.area).toBeLessThan(0);
    expect(ring.area).toBeCloseTo(100 - 4 * Math.PI, 8);
    expect(loopText(disc.loop)).toEqual(['c:closed']);
    expect(disc.area).toBeCloseTo(4 * Math.PI, 8);
  });

  it('gives each hole to the innermost region around it', () => {
    const sketch = new SketchBuilder()
      .rectangle('r', 0, 0, 20, 20)
      .circle('big', 10, 10, 6)
      .circle('small', 10, 10, 2)
      .circle('side', 18, 18, 1)
      .build();
    const found = regions(sketch);
    expect(found.map((r) => r.holes.set.length).sort()).toEqual([0, 0, 1, 2]);
    const outer = found.find((r) => r.holes.set.length === 2)!;
    expect(outer.holes.set.map((h) => loopText(h))).toEqual([['big:closed'], ['side:closed']]);
    expect(() => readSet(outer.holes)).not.toThrow();
  });

  it('walks only the outside of a subdivided island as the hole', () => {
    const sketch = new SketchBuilder()
      .rectangle('o', 0, 0, 20, 20)
      .rectangle('i', 5, 5, 15, 15)
      .line('m', 'i1', 'i3')
      .build();
    const found = regions(sketch);
    expect(found).toHaveLength(3);
    const ring = found.find((r) => r.holes.set.length === 1)!;
    expect(loopText(ring.holes.set[0]!).sort()).toEqual(['ib:i2<i1', 'il:i1<i4', 'it:i4<i3', 'ir:i3<i2'].sort());
  });

  it('ignores a line linking an island to the boundary around it', () => {
    const sketch = new SketchBuilder()
      .rectangle('r', 0, 0, 10, 10)
      .circle('c', 5, 5, 2)
      .point('e', 7, 5)
      .line('link', 'r2', 'e')
      .build();
    const found = regions(sketch);
    expect(found).toHaveLength(2);
    const uses = found.flatMap((r) => [...r.loop, ...r.holes.set.flat()]).map(useText);
    expect(uses.filter((u) => u.startsWith('link'))).toEqual([]);
    expect(found.find((r) => r.holes.set.length === 1)).toBeDefined();
  });

  it('keeps an island that nearly touches the boundary around it', () => {
    const b = new SketchBuilder().circle('o', 0, 0, 100).circle('i', 99.9, 0, 0.09);
    expect(regions(b.build()).find((r) => r.holes.set.length === 1)).toBeDefined();
  });
});

describe('crossings', () => {
  it('splits a rectangle along a line running past both sides', () => {
    const sketch = new SketchBuilder().rectangle('r', 0, 0, 10, 10).segment('m', [4, -2], [4, 12]).build();
    expect(outerUses(sketch).sort()).toEqual(
      [
        'm:x(rb,-0)>x(rt,+0)',
        'm:x(rt,+0)<x(rb,-0)',
        'rb:r1>x(m,+0)',
        'rb:x(m,+0)>r2',
        'rl:r4>r1',
        'rr:r2>r3',
        'rt:r3>x(m,-0)',
        'rt:x(m,-0)>r4',
      ].sort(),
    );
    expect(areas(sketch)).toEqual([40, 60]);
  });

  it('names a line ending on a side as a point on the line and a crossing on the side', () => {
    const sketch = new SketchBuilder()
      .rectangle('r', 0, 0, 10, 10)
      .point('p', 4, 0)
      .point('q', 4, 10)
      .line('m', 'p', 'q')
      .build();
    const uses = outerUses(sketch);
    expect(uses).toContain('m:p>q');
    expect(uses).toContain('m:q<p');
    expect(uses).toContain('rb:r1>x(m,+0)');
    expect(uses).toContain('rb:x(m,+0)>r2');
  });

  it('subdivides a rectangle by two crossing lines into four', () => {
    const sketch = new SketchBuilder()
      .rectangle('r', 0, 0, 10, 10)
      .segment('v', [5, -1], [5, 11])
      .segment('h', [-1, 3], [11, 3])
      .build();
    expect(areas(sketch)).toEqual([15, 15, 35, 35]);
    expect(outerUses(sketch)).toContain('v:x(rb,-0)>x(h,-0)');
    expect(outerUses(sketch)).toContain('h:x(v,+0)<x(rl,-0)');
  });

  it('subdivides a rectangle by several lines, counting crossings along each curve', () => {
    const sketch = new SketchBuilder()
      .rectangle('r', 0, 0, 12, 4)
      .segment('z', [-1, 2], [13, 2])
      .segment('u1', [3, -1], [3, 5])
      .segment('u2', [9, -1], [9, 5])
      .build();
    expect(regions(sketch)).toHaveLength(6);
    expect(outerUses(sketch)).toContain('z:x(u1,+0)>x(u2,+0)');
    expect(outerUses(sketch)).toContain('rt:x(u2,-0)>x(u1,-0)');
    expect(outerUses(sketch)).toContain('u1:x(rb,-0)>x(z,-0)');
  });

  it('tells the two crossings of a line through a circle by their sense', () => {
    const sketch = new SketchBuilder().rectangle('r', 0, 0, 10, 10).circle('c', 5, 0, 3).build();
    expect(outerUses(sketch)).toContain('rb:x(c,-0)>x(c,+0)');
    expect(outerUses(sketch)).toContain('rb:r1>x(c,-0)');
    expect(outerUses(sketch)).toContain('rb:x(c,+0)>r2');
  });

  it('cuts a rectangle with a crossing circle into three', () => {
    const sketch = new SketchBuilder().rectangle('r', 0, 0, 10, 10).circle('c', 10, 5, 3).build();
    const found = regions(sketch);
    expect(found).toHaveLength(3);
    const uses = found.flatMap((r) => loopText(r.loop));
    expect(uses).toContain('c:x(rr,-0)>x(rr,+0)');
    expect(uses).toContain('c:x(rr,+0)>x(rr,-0)');
    expect(uses).toContain('rr:x(c,-0)>x(c,+0)');
    expect(uses).toContain('c:x(rr,+0)<x(rr,-0)');
    const total = found.reduce((sum, r) => sum + r.area, 0);
    expect(total).toBeCloseTo(100 + (Math.PI * 9) / 2, 8);
  });

  it('finds two crescents and a lens in intersecting circles', () => {
    const sketch = new SketchBuilder().circle('a', 0, 0, 5).circle('b', 6, 0, 5).build();
    const found = regions(sketch);
    expect(found).toHaveLength(3);
    const lens = 2 * 25 * Math.acos(3 / 5) - 3 * Math.sqrt(100 - 36);
    const sorted = found.map((r) => r.area).sort((x, y) => x - y);
    expect(sorted[0]).toBeCloseTo(lens, 8);
    expect(sorted[1]).toBeCloseTo(25 * Math.PI - lens, 8);
    expect(sorted[2]).toBeCloseTo(25 * Math.PI - lens, 8);
    const uses = found.map((r) => loopText(r.loop).sort());
    expect(uses).toContainEqual(['a:x(b,+0)>x(b,-0)', 'b:x(a,+0)<x(a,-0)']);
    expect(uses).toContainEqual(['a:x(b,-0)>x(b,+0)', 'b:x(a,-0)>x(a,+0)']);
    expect(uses).toContainEqual(['a:x(b,+0)<x(b,-0)', 'b:x(a,+0)>x(a,-0)']);
  });

  it('walks a circle tangent inside a rectangle as part of the outer loop', () => {
    const sketch = new SketchBuilder().rectangle('r', 0, 0, 10, 10).circle('c', 5, 3, 3).build();
    const found = regions(sketch);
    expect(found).toHaveLength(2);
    expect(loopText(found.find((r) => r.loop.length === 1)!.loop)).toEqual(['c:closed']);
    const rest = found.find((r) => r.loop.length > 1)!;
    expect(loopText(rest.loop)).toContain('c:x(rb,=0)<x(rb,=0)');
    expect(rest.area).toBeCloseTo(100 - 9 * Math.PI, 8);
    expect(rest.holes.set).toEqual([]);
    expect(loopText(rest.loop)).toContain('rb:r1>x(c,=0)');
    expect(loopText(rest.loop)).toContain('rb:x(c,=0)>r2');
  });

  it('keeps a line tangent to a circle out of the circle', () => {
    const sketch = new SketchBuilder().circle('c', 0, 0, 2).segment('t', [-5, 2], [5, 2]).build();
    expect(loops(sketch)).toEqual([['c:closed']]);
  });

  it('walks a stretch two lines run along once', () => {
    const sketch = new SketchBuilder().rectangle('r', 0, 0, 10, 10).segment('a', [2, 0], [8, 0]).build();
    expect(areas(sketch)).toEqual([100]);
  });

  it('walks two equal circles once, on the smaller key', () => {
    const sketch = new SketchBuilder().circle('b', 0, 0, 3).circle('a', 0, 0, 3).build();
    expect(loops(sketch)).toEqual([['a:closed']]);
  });

  it('crosses arcs like circles and stops at their ends', () => {
    const sketch = new SketchBuilder()
      .rectangle('r', 0, 0, 10, 10)
      .point('s', 5 + 3 * Math.cos(-0.3), 12 + 3 * Math.sin(-0.3))
      .point('e', 5 + 3 * Math.cos(Math.PI + 0.3), 12 + 3 * Math.sin(Math.PI + 0.3))
      .arc('k', [5, 12], 's', 'e')
      .build();
    expect(regions(sketch)).toHaveLength(1);
    const dipping = new SketchBuilder()
      .rectangle('r', 0, 0, 10, 10)
      .point('s', 9, 11)
      .point('e', 1, 11)
      .arc('k', [5, 11], 'e', 's')
      .build();
    expect(regions(dipping)).toHaveLength(2);
  });
});

describe('tangent curves', () => {
  it('separates a circle tangent inside another at the origin of the outer one', () => {
    const sketch = new SketchBuilder().circle('a', 0, 0, 5).circle('b', 3, 0, 2).build();
    const found = regions(sketch);
    expect(found).toHaveLength(2);
    expect(found.map((r) => r.area).sort((x, y) => x - y)[0]).toBeCloseTo(4 * Math.PI, 8);
    expect(found.reduce((sum, r) => sum + r.area, 0)).toBeCloseTo(25 * Math.PI, 8);
  });

  it('keeps circles tangent from outside as two discs', () => {
    const sketch = new SketchBuilder().circle('a', 0, 0, 5).circle('b', 7, 0, 2).build();
    expect(loops(sketch).sort()).toEqual([['a:closed'], ['b:closed']]);
  });

  it('walks a slot of lines and arcs meeting along one tangent', () => {
    const sketch = new SketchBuilder()
      .point('a', 0, 0)
      .point('b', 10, 0)
      .point('c', 10, 4)
      .point('d', 0, 4)
      .line('l1', 'a', 'b')
      .arc('k1', [10, 2], 'b', 'c')
      .line('l2', 'c', 'd')
      .arc('k2', [0, 2], 'd', 'a')
      .build();
    expect(loops(sketch)[0]!.sort()).toEqual(['k1:b>c', 'k2:d>a', 'l1:a>b', 'l2:c>d']);
    expect(regions(sketch)[0]!.area).toBeCloseTo(40 + 4 * Math.PI, 8);
  });

  it('tells apart a line and an arc leaving one point along one tangent', () => {
    const sketch = new SketchBuilder()
      .point('p', 0, 0)
      .point('q', 10, 0)
      .point('r', 10, 10)
      .point('e', 5, 5)
      .line('l', 'p', 'q')
      .line('m', 'q', 'r')
      .line('n', 'r', 'p')
      .arc('k', [0, 5], 'p', 'e')
      .line('o', 'e', 'q')
      .build();
    const found = regions(sketch);
    expect(found).toHaveLength(3);
    const total = found.reduce((sum, r) => sum + r.area, 0);
    expect(total).toBeCloseTo(50, 6);
  });

  it('walks two equal ellipses once', () => {
    const shape: CurveShape = { kind: 'ellipse', center: [0, 0], majorEnd: [6, 0], minorRadius: 3 };
    const sketch = new SketchBuilder()
      .add(drawn('a'), shape, { kind: 'none' })
      .add(drawn('b'), shape, { kind: 'none' })
      .build();
    expect(regions(sketch)).toHaveLength(1);
    expect(regions(sketch)[0]!.area).toBeCloseTo(18 * Math.PI, 6);
  });
});

describe('random sketches', () => {
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  function coverage(detection: ReturnType<typeof detectRegions>, p: Vec2): number {
    let count = 0;
    for (const region of detection.regions) {
      const inside = (cycle: (typeof region)['outer']) => locateInCycle(detection.arrangement, cycle, p).inside;
      if (inside(region.outer) && !region.inner.some(inside)) count++;
    }
    return count;
  }

  it('tiles the union of random discs with regions that never overlap', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const next = random(seed * 977);
      const discs = Array.from({ length: 3 + (seed % 7) }, () => ({
        x: next() * 40,
        y: next() * 40,
        r: 3 + next() * 12,
      }));
      const b = new SketchBuilder();
      discs.forEach((d, i) => b.circle(`c${i}`, d.x, d.y, d.r));
      const detection = detectRegions(b.build());
      for (let i = 0; i < 60; i++) {
        const p: Vec2 = [next() * 60 - 10, next() * 60 - 10];
        const covered = discs.some((d) => Math.hypot(p[0] - d.x, p[1] - d.y) < d.r);
        expect(coverage(detection, p)).toBe(covered ? 1 : 0);
      }
    }
  });
});

describe('curve keys', () => {
  it('keys live descendants by their root and walks them as one use', () => {
    const sketch = new SketchBuilder()
      .point('a', 0, 0)
      .point('m', 5, 0)
      .point('b', 10, 0)
      .point('c', 10, 10)
      .line('l1', 'a', 'm', 'root')
      .line('l2', 'm', 'b', 'root')
      .line('l3', 'b', 'c')
      .line('l4', 'c', 'a')
      .build();
    expect(loops(sketch)).toEqual([['l3:b>c', 'l4:c>a', 'root:a>b']]);
  });

  it('counts crossings against all live descendants of the other curve together', () => {
    const sketch = new SketchBuilder()
      .rectangle('r', 0, 0, 12, 10)
      .segment('w1', [3, -1], [3, 11], 'w')
      .segment('w2', [8, -1], [8, 11], 'w')
      .build();
    expect(outerUses(sketch)).toContain('rb:x(w,+0)>x(w,+1)');
    expect(outerUses(sketch)).toContain('rt:x(w,-0/1)>x(w,-1/0)');
  });

  it('takes the sense from the descendant the loop turns onto', () => {
    const sketch = new SketchBuilder()
      .rectangle('r', 0, 0, 12, 10)
      .point('t', 6, 0)
      .point('u', 3, 10)
      .point('v', 9, 10)
      .line('w1', 'u', 't', 'w')
      .line('w2', 't', 'v', 'w')
      .build();
    const uses = outerUses(sketch);
    expect(uses).toContain('rb:r1>x(w,-0)');
    expect(uses).toContain('rb:x(w,+0)>r2');
    expect(uses).toContain('rt:x(w,-0)>x(w,+0)');
  });

  it('counts one place once when two descendants meet on the curve', () => {
    const sketch = new SketchBuilder()
      .rectangle('r', 0, 0, 12, 10)
      .point('t', 6, 0)
      .point('u', 6, 11)
      .point('v', 6, -3)
      .line('w1', 'u', 't', 'w')
      .line('w2', 't', 'v', 'w')
      .segment('w3', [9, 11], [9, -1], 'w')
      .build();
    expect(outerUses(sketch)).toContain('rb:x(w,-0)>x(w,-1)');
  });

  it('ends a defining external curve at its extremities', () => {
    const sketch = new SketchBuilder()
      .point('a', 0, 0)
      .point('b', 10, 0)
      .add(drawn('ext'), { kind: 'line', start: [0, 8], end: [10, 8] }, { kind: 'extremities' })
      .line('base', 'a', 'b')
      .segment('s1', [10, 0], [10, 8])
      .segment('s2', [0, 8], [0, 0])
      .build();
    expect(outerUses(sketch)).toContain('ext:^end<^start');
  });

  it('bounds regions with glyph contours in the font direction', () => {
    const outer = { glyph: { text: 'txt_a', glyph: 0, contour: 0 } };
    const inner = { glyph: { text: 'txt_a', glyph: 0, contour: 1 } };
    const square = (a: number, b: number): Vec2[][] => [
      [
        [a, a],
        [a, b],
      ],
      [
        [a, b],
        [b, b],
      ],
      [
        [b, b],
        [b, a],
      ],
      [
        [b, a],
        [a, a],
      ],
    ];
    const reversed = square(3, 7)
      .reverse()
      .map((segment) => [...segment].reverse());
    const sketch = new SketchBuilder()
      .add(outer, { kind: 'contour', segments: square(0, 10) }, { kind: 'none' })
      .add(inner, { kind: 'contour', segments: reversed }, { kind: 'none' })
      .build();
    const found = regions(sketch);
    expect(found).toHaveLength(2);
    const ring = found.find((r) => r.holes.set.length === 1)!;
    expect(ring.loop).toEqual([{ closed: { curve: outer } }]);
    expect(ring.holes.set[0]).toEqual([{ closed: { curve: inner } }]);
    expect(ring.area).toBeCloseTo(100 - 16, 8);
  });

  it('crosses a glyph contour with a drawn line', () => {
    const key = { glyph: { text: 'txt_a', glyph: 2, contour: 0 } };
    const sketch = new SketchBuilder()
      .add(
        key,
        {
          kind: 'contour',
          segments: [
            [
              [0, 0],
              [10, 0],
            ],
            [
              [10, 0],
              [15, 5],
              [10, 10],
            ],
            [
              [10, 10],
              [0, 10],
            ],
            [
              [0, 10],
              [-5, 5],
              [0, 0],
            ],
          ],
        },
        { kind: 'none' },
      )
      .segment('m', [5, -1], [5, 11])
      .build();
    expect(regions(sketch)).toHaveLength(2);
    const uses = outerUses(sketch);
    expect(uses).toContain('txt_a/2/0:x(m,+0)>x(m,-0)');
    expect(uses).toContain('m:x(txt_a/2/0,-0)>x(txt_a/2/0,+0)');
  });
});

describe('general curves', () => {
  const ellipse: CurveShape = { kind: 'ellipse', center: [0, 0], majorEnd: [6, 0], minorRadius: 3 };

  it('takes an ellipse whole and across a line', () => {
    const whole = new SketchBuilder().add(drawn('e'), ellipse, { kind: 'none' }).build();
    expect(loops(whole)).toEqual([['e:closed']]);
    expect(regions(whole)[0]!.area).toBeCloseTo(18 * Math.PI, 6);
    const cut = new SketchBuilder().add(drawn('e'), ellipse, { kind: 'none' }).segment('m', [-10, 1], [10, 1]).build();
    expect(regions(cut)).toHaveLength(2);
    expect(regions(cut).reduce((sum, r) => sum + r.area, 0)).toBeCloseTo(18 * Math.PI, 6);
  });

  it('closes an elliptical arc with its chord', () => {
    const sketch = new SketchBuilder()
      .point('a', 6, 0)
      .point('b', -6, 0)
      .add(
        drawn('e'),
        {
          kind: 'ellipticalArc',
          center: [0, 0],
          majorEnd: [6, 0],
          minorRadius: 3,
          start: [6, 0],
          end: [-6, 0],
        },
        { kind: 'points', start: 'a', end: 'b' },
      )
      .line('l', 'b', 'a')
      .build();
    expect(loops(sketch)).toEqual([['e:a>b', 'l:b>a']]);
    expect(regions(sketch)[0]!.area).toBeCloseTo(9 * Math.PI, 6);
  });

  const quadratic = (poles: Vec2[]): CurveShape => ({
    kind: 'nurbs',
    degree: 2,
    poles,
    weights: poles.map(() => 1),
    knots: [0, 1],
    multiplicities: [3, 3],
    periodic: false,
  });

  it('closes a parabola with its chord', () => {
    const sketch = new SketchBuilder()
      .point('a', 0, 0)
      .point('b', 10, 0)
      .add(
        drawn('n'),
        quadratic([
          [0, 0],
          [5, -10],
          [10, 0],
        ]),
        {
          kind: 'points',
          start: 'a',
          end: 'b',
        },
      )
      .line('l', 'b', 'a')
      .build();
    expect(regions(sketch)[0]!.area).toBeCloseTo((2 / 3) * 10 * 5, 6);
  });

  it('makes a circle from a rational periodic curve and starts it at its first knot', () => {
    const w = Math.SQRT1_2;
    const shape: CurveShape = {
      kind: 'nurbs',
      degree: 2,
      poles: [
        [1, 0],
        [1, 1],
        [0, 1],
        [-1, 1],
        [-1, 0],
        [-1, -1],
        [0, -1],
        [1, -1],
      ],
      weights: [1, w, 1, w, 1, w, 1, w],
      knots: [0, 1, 2, 3, 4],
      multiplicities: [2, 2, 2, 2, 2],
      periodic: true,
    };
    const sketch = new SketchBuilder().add(drawn('n'), shape, { kind: 'none' }).build();
    expect(loops(sketch)).toEqual([['n:closed']]);
    expect(regions(sketch)[0]!.area).toBeCloseTo(Math.PI, 6);
    const start = detectRegions(sketch).arrangement.curves[0]!.curve.point(0);
    expect(start[0]).toBeCloseTo(1, 12);
    expect(start[1]).toBeCloseTo(0, 12);
  });

  it('gives a spline closing on one point a closed use', () => {
    const poles: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const sketch = new SketchBuilder()
      .point('p', 0, 0)
      .add(
        drawn('n'),
        {
          kind: 'nurbs',
          degree: 2,
          poles,
          weights: poles.map(() => 1),
          knots: [0, 1, 2, 3],
          multiplicities: [3, 1, 1, 3],
          periodic: false,
        },
        { kind: 'points', start: 'p', end: 'p' },
      )
      .build();
    expect(loops(sketch)).toEqual([['n:closed']]);
  });

  it('closes an arc whose two ends coincide', () => {
    const sketch = new SketchBuilder().point('p', 3, 0).arc('k', [0, 0], 'p', 'p').build();
    expect(loops(sketch)).toEqual([['k:closed']]);
    expect(regions(sketch)[0]!.area).toBeCloseTo(9 * Math.PI, 8);
  });

  const unclamped = (poles: Vec2[]): CurveShape => ({
    kind: 'nurbs',
    degree: 2,
    poles,
    weights: poles.map(() => 1),
    knots: [0, 1, 2, 3, 4, 5, 6],
    multiplicities: [1, 1, 1, 1, 1, 1, 1],
    periodic: false,
  });

  it('ends an unclamped curve where its parameter range ends, not at its poles', () => {
    const sketch = new SketchBuilder()
      .add(
        drawn('n'),
        unclamped([
          [-4, 0],
          [4, 0],
          [4, 8],
          [-4, 8],
        ]),
        { kind: 'extremities' },
      )
      .segment('s', [0, 8], [0, 0])
      .build();
    expect(loops(sketch)).toEqual([['n:^start>^end', 's:s0>s1']]);
  });

  it('closes an unclamped curve when the ends of its parameter range coincide', () => {
    const sketch = new SketchBuilder()
      .add(
        drawn('n'),
        unclamped([
          [-2, 0],
          [2, 0],
          [4, 6],
          [-4, -6],
        ]),
        { kind: 'extremities' },
      )
      .build();
    expect(loops(sketch)).toEqual([['n:closed']]);
  });

  it('closes a curve whose two end points lie in one place', () => {
    const poles: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const sketch = new SketchBuilder()
      .point('p', 0, 0)
      .point('q', 0, 0)
      .add(
        drawn('n'),
        {
          kind: 'nurbs',
          degree: 2,
          poles,
          weights: poles.map(() => 1),
          knots: [0, 1, 2, 3],
          multiplicities: [3, 1, 1, 3],
          periodic: false,
        },
        { kind: 'points', start: 'p', end: 'q' },
      )
      .build();
    expect(loops(sketch)).toEqual([['n:closed']]);
  });

  it('splits a curve at its own crossing', () => {
    const poles: Vec2[] = [
      [0, 0],
      [20, 12],
      [-10, 12],
      [10, 0],
    ];
    const sketch = new SketchBuilder()
      .point('a', 0, 0)
      .point('b', 10, 0)
      .add(
        drawn('n'),
        {
          kind: 'nurbs',
          degree: 3,
          poles,
          weights: poles.map(() => 1),
          knots: [0, 1],
          multiplicities: [4, 4],
          periodic: false,
        },
        { kind: 'points', start: 'a', end: 'b' },
      )
      .build();
    expect(loops(sketch)).toEqual([['n:x(n,-0)>x(n,+0)']]);
  });
});

describe('canonical start', () => {
  it('starts at the smallest from when a curve has several uses', () => {
    const sketch = new SketchBuilder()
      .rectangle('r', 0, 0, 10, 10)
      .point('a', 3, 0)
      .point('b', 3, 5)
      .point('c', 7, 5)
      .point('d', 7, 0)
      .line('s1', 'a', 'b')
      .line('s2', 'b', 'c')
      .line('s3', 'c', 'd')
      .build();
    const around = regions(sketch).find((r) => r.loop.length > 4)!;
    const onBottom = around.loop.filter((u) => useText(u).startsWith('rb:'));
    expect(onBottom).toHaveLength(2);
    const froms = onBottom.map((u) => canonicalBytes('open' in u ? u.open.from : null));
    const smallest = compareBytes(froms[0]!, froms[1]!) < 0 ? onBottom[0] : onBottom[1];
    expect(around.loop[0]).toEqual(smallest);
  });

  it('settles a repeated curve and from by the rotation that reads smallest', () => {
    const p = { point: { id: 'p' } };
    const q = { point: { id: 'q' } };
    const a: Use = { open: { curve: drawn('c'), from: p, to: q, reversed: false } };
    const b: Use = { open: { curve: drawn('c'), from: p, to: q, reversed: true } };
    const d: Use = { closed: { curve: drawn('d') } };
    expect(canonicalStart([b, d, a, d])).toEqual([a, d, b, d]);
  });

  it('does not depend on table order', () => {
    const sketch = new SketchBuilder().rectangle('r', 0, 0, 10, 10).circle('c', 10, 5, 3).build();
    const reversed = { ...sketch, curves: [...sketch.curves].reverse() };
    expect(regions(reversed).map((r) => r.identity)).toEqual(regions(sketch).map((r) => r.identity));
  });

  it('writes identity as the sorted set of uses', () => {
    const sketch = new SketchBuilder().rectangle('r', 0, 0, 10, 10).circle('c', 5, 5, 2).build();
    for (const region of regions(sketch)) {
      expect(readSet(region.identity)).toHaveLength(region.loop.length + region.holes.set.flat().length);
    }
  });
});
