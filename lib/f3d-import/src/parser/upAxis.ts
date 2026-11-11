/**
 * The axis a design was modelled with up. Fusion keeps it per design: each
 * saved view (`1787C882…`, holding the view's name) names its camera
 * (`736DEAAF…`) as its first reference, and a camera ends with its target and
 * then its up vector (3 f64 each). The FRONT view's up is the design's up:
 * (0, 0, 1) for a design modelled Z up, (0, 1, 0) for one modelled Y up.
 */
import { type DesignIndex, primaryRange, refsIn } from './designIndex';

const VIEW = '1787C882';
const CAMERA = '736DEAAF';
const FRONT = new Uint8Array([...'FRONT'].flatMap((c) => [c.charCodeAt(0), 0]));

function holds(bytes: Uint8Array, start: number, end: number, needle: Uint8Array): boolean {
  outer: for (let i = start; i + needle.length <= end; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** `z` or `y` from the design's FRONT view, or null when it has none or its up is neither axis. */
export function readUpAxis(index: DesignIndex): 'y' | 'z' | null {
  const view = (index.idsOf.get(VIEW) ?? [])
    .map((id) => primaryRange(index, id))
    .find((r) => r !== undefined && holds(index.bulk, r.start, r.end, FRONT));
  if (!view) return null;
  const camera = refsIn(index, view.start, view.end)[0];
  if (!camera || index.typeOf.get(camera.id)?.key !== CAMERA) return null;
  const range = primaryRange(index, camera.id);
  if (!range || range.end - range.start < 24) return null;
  const dv = new DataView(index.bulk.buffer, index.bulk.byteOffset, index.bulk.byteLength);
  const up = [24, 16, 8].map((back) => dv.getFloat64(range.end - back, true));
  const is = (x: number, y: number, z: number): boolean =>
    Math.abs((up[0] as number) - x) < 1e-6 &&
    Math.abs((up[1] as number) - y) < 1e-6 &&
    Math.abs((up[2] as number) - z) < 1e-6;
  return is(0, 0, 1) ? 'z' : is(0, 1, 0) ? 'y' : null;
}
