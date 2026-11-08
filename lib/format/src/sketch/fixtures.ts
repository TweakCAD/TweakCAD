import type { CurveAnchors, CurveKey, CurveShape, SolvedCurve, SolvedSketch, Use, UseEnd, Vec2 } from './types';

export function drawn(id: string): CurveKey {
  return { drawn: { id } };
}

/** Builds solved sketches by name for tests. */
export class SketchBuilder {
  readonly points = new Map<string, Vec2>();
  readonly curves: SolvedCurve[] = [];

  point(id: string, x: number, y: number): this {
    this.points.set(id, [x, y]);
    return this;
  }

  private at(id: string): Vec2 {
    const p = this.points.get(id);
    if (!p) throw new Error(`no point ${id}`);
    return p;
  }

  add(key: CurveKey, shape: CurveShape, anchors: CurveAnchors): this {
    this.curves.push({ key, shape, anchors });
    return this;
  }

  /** A line between two named points; `root` names the curve it descends from. */
  line(id: string, a: string, b: string, root = id): this {
    return this.add(
      drawn(root),
      { kind: 'line', start: this.at(a), end: this.at(b) },
      { kind: 'points', start: a, end: b },
    );
  }

  /** A line from fresh points, named `<id>0` and `<id>1`. */
  segment(id: string, a: Vec2, b: Vec2, root = id): this {
    this.point(`${id}0`, a[0], a[1]).point(`${id}1`, b[0], b[1]);
    return this.line(id, `${id}0`, `${id}1`, root);
  }

  /** Four lines `<id>b`, `<id>r`, `<id>t`, `<id>l` counter-clockwise from the lower left. */
  rectangle(id: string, x0: number, y0: number, x1: number, y1: number): this {
    this.point(`${id}1`, x0, y0).point(`${id}2`, x1, y0).point(`${id}3`, x1, y1).point(`${id}4`, x0, y1);
    return this.line(`${id}b`, `${id}1`, `${id}2`)
      .line(`${id}r`, `${id}2`, `${id}3`)
      .line(`${id}t`, `${id}3`, `${id}4`)
      .line(`${id}l`, `${id}4`, `${id}1`);
  }

  circle(id: string, x: number, y: number, radius: number): this {
    return this.add(drawn(id), { kind: 'circle', center: [x, y], radius }, { kind: 'none' });
  }

  arc(id: string, center: Vec2, a: string, b: string, root = id): this {
    return this.add(
      drawn(root),
      { kind: 'arc', center, start: this.at(a), end: this.at(b) },
      { kind: 'points', start: a, end: b },
    );
  }

  build(): SolvedSketch {
    return {
      points: [...this.points].map(([id, [x, y]]) => ({ id, x, y })),
      curves: this.curves,
    };
  }
}

function keyName(key: CurveKey): string {
  return 'drawn' in key ? key.drawn.id : `${key.glyph.text}/${key.glyph.glyph}/${key.glyph.contour}`;
}

function endName(end: UseEnd): string {
  if ('point' in end) return end.point.id;
  if ('extremity' in end) return `^${end.extremity.which}`;
  const { sense, k, kWith } = end.cross;
  const sign = sense > 0 ? '+' : sense < 0 ? '-' : '=';
  const numbers = k === kWith ? `${k}` : `${k}/${kWith}`;
  return `x(${keyName(end.cross.with)},${sign}${numbers})`;
}

/**
 * A use as short text: `curve:from>to`, `curve:from<to` when reversed,
 * `curve:closed`. A crossing reads `x(with,+k)`, or `x(with,+k/kWith)` when they differ.
 */
export function useText(use: Use): string {
  if ('closed' in use) return `${keyName(use.closed.curve)}:closed`;
  const { curve, from, to, reversed } = use.open;
  return `${keyName(curve)}:${endName(from)}${reversed ? '<' : '>'}${endName(to)}`;
}

export function loopText(loop: readonly Use[]): string[] {
  return loop.map(useText);
}
