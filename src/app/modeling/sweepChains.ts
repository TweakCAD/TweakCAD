/**
 * Chains of sketch curves, read from the display's polylines: the curves of
 * one sketch joined end to end with a clicked curve, stopping where three
 * meet, so one click takes a drawn path.
 */
import type { Display, Key, SketchCurveDisplay } from '@tweakcad/worker/src/v2/service/types';
import { sketchesOf } from './profiles';

/** Two curve ends closer than this (mm) meet. */
const MEETS = 1e-6;

type V3 = [number, number, number];

function endsOf(curve: SketchCurveDisplay): [V3, V3] {
  const p = curve.points;
  const last = p.length - 3;
  return [
    [p[0] as number, p[1] as number, p[2] as number],
    [p[last] as number, p[last + 1] as number, p[last + 2] as number],
  ];
}

const meets = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= MEETS;

/** The keys of the curves joined end to end with `key`, in order along the chain; just `key` when it is no sketch curve. */
export function connectedCurves(display: Display | null, part: string, key: Key): Key[] {
  const sketch = sketchesOf(display, part).find((s) => s.curves.some((c) => c.key === key));
  const start = sketch?.curves.find((c) => c.key === key);
  if (!sketch || !start) return [key];
  const curves = sketch.curves.filter((c) => c.points.length >= 6);

  /** The curves from `tip` onwards, away from what `seen` holds. */
  const walk = (tip: V3, seen: Set<Key>): SketchCurveDisplay[] => {
    const out: SketchCurveDisplay[] = [];
    let at = tip;
    for (;;) {
      const here = curves.filter((c) => !seen.has(c.key) && endsOf(c).some((e) => meets(e, at)));
      const other = curves.filter((c) => seen.has(c.key) && endsOf(c).some((e) => meets(e, at)));
      if (here.length !== 1 || other.length > 1) return out;
      const next = here[0] as SketchCurveDisplay;
      seen.add(next.key);
      out.push(next);
      const [a, b] = endsOf(next);
      at = meets(a, at) ? b : a;
    }
  };

  const seen = new Set([start.key]);
  const [a, b] = endsOf(start);
  const forward = walk(b, seen);
  const backward = walk(a, seen);
  return [...backward.reverse(), start, ...forward].map((c) => c.key);
}
