/** What the import and export tests share: reading imported rows, and geometry over rows. */
import { ValueEvaluator } from '@tweakcad/format';
import { expect } from 'vitest';
import { SketchGeometry } from '../geometry';
import { curvePoints, type Json, type P2 } from '../rows';
import type { SketchImport } from './importRows';

export interface Imported {
  points: Json[];
  curves: Json[];
  /** A point's coordinates. */
  at: (id: unknown) => P2;
  kinds: () => string[];
  ofKind: (kind: string) => Json[];
  /** The value objects' numbers (knots, weights, rho, degree). */
  numbers: (values: unknown) => number[];
}

export function imported(result: SketchImport): Imported {
  const points = result.change.add?.points ?? [];
  const curves = result.change.add?.curves ?? [];
  const byId = new Map(points.map((p) => [p.id as string, [p.x as number, p.y as number] as P2]));
  const values = new ValueEvaluator({ points, curves });
  return {
    points,
    curves,
    at: (id) => {
      const p = byId.get(id as string);
      if (!p) throw new Error(`no point ${String(id)}`);
      return p;
    },
    kinds: () => curves.map((c) => c.kind as string),
    ofKind: (kind) => curves.filter((c) => c.kind === kind),
    numbers: (v) => (Array.isArray(v) ? v : [v]).map((x) => values.number(x, { type: 'number', quantity: 'ratio' })),
  };
}

/** The sketch geometry of rows at their stored positions. */
export function geometryOf(points: Json[], curves: Json[]): SketchGeometry {
  const inputs = { points, curves, constraints: [] };
  return new SketchGeometry(inputs, new ValueEvaluator(inputs));
}

/** Each curve as its kind, the coordinates of its points in field order, and its radius or minor radius. */
export function described(points: Json[], curves: Json[]): { kind: string; points: P2[]; radius?: number }[] {
  const byId = new Map(points.map((p) => [p.id as string, [p.x as number, p.y as number] as P2]));
  return curves.map((c) => {
    const radius = (c.radius ?? c.minorRadius) as number | undefined;
    return {
      kind: c.kind as string,
      points: curvePoints(c).map((id) => byId.get(id) as P2),
      ...(radius === undefined ? {} : { radius }),
    };
  });
}

/** Expects two curve descriptions to agree to `digits` decimals, after moving `b` by `shift`. */
export function sameCurves(
  a: ReturnType<typeof described>,
  b: ReturnType<typeof described>,
  shift: P2 = [0, 0],
  digits = 9,
): void {
  expect(b.map((c) => c.kind)).toEqual(a.map((c) => c.kind));
  a.forEach((c, i) => {
    const d = b[i] as (typeof b)[number];
    expect(d.points.length).toBe(c.points.length);
    c.points.forEach((p, j) => {
      const q = d.points[j] as P2;
      expect(q[0] - shift[0]).toBeCloseTo(p[0], digits);
      expect(q[1] - shift[1]).toBeCloseTo(p[1], digits);
    });
    if (c.radius !== undefined) expect(d.radius).toBeCloseTo(c.radius, digits);
  });
}
