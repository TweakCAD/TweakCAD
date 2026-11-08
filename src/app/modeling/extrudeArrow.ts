/** Where the Extrude panel's distance arrow stands. */
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import type { ExtrudeForm, ExtrudeProfile } from './extrude';
import { sketchesOf } from './profiles';

const num = (t: string): number | null => {
  const v = Number(t.trim() === '' ? '0' : t);
  return Number.isFinite(v) ? v : null;
};

/**
 * Where the first side of the extrude ends, for its distance arrow: the
 * centre of the picked profiles' outer loops moved along the direction by
 * the start offset and the distance, and that direction. Null when the
 * first side is not a plain distance or the profiles are not shown.
 */
export function distanceArrow(
  display: Display | null,
  part: string,
  form: ExtrudeForm,
  profiles: readonly ExtrudeProfile[],
): { at: [number, number, number]; direction: [number, number, number]; distance: number } | null {
  const distance = num(form.distance);
  const offset = form.startType === 'face' ? null : num(form.startOffset ?? '0');
  if (
    (form.sides ?? 'one') === 'symmetric' ||
    form.extent !== 'distance' ||
    distance === null ||
    offset === null ||
    form.startType === 'face'
  )
    return null;
  let [x, y, z] = [0, 0, 0];
  let n = 0;
  let normal: readonly [number, number, number] | null = null;
  for (const p of profiles) {
    if ('kept' in p) continue;
    const sketch = sketchesOf(display, part).find((s) => s.feature === p.sketch);
    const loop = sketch?.regions.find((r) => r.row === p.row)?.loops[0];
    if (!sketch || !loop) continue;
    normal = sketch.frame.normal;
    for (let i = 0; i + 2 < loop.length; i += 3) {
      x += loop[i] ?? 0;
      y += loop[i + 1] ?? 0;
      z += loop[i + 2] ?? 0;
      n++;
    }
  }
  if (n === 0 || !normal) return null;
  const s = form.reversed ? -1 : 1;
  const direction: [number, number, number] = [s * normal[0], s * normal[1], s * normal[2]];
  const along = offset + distance;
  return {
    at: [x / n + direction[0] * along, y / n + direction[1] * along, z / n + direction[2] * along],
    direction,
    distance,
  };
}
