/**
 * Standing a Z-up design on the app's Y-up axes: the turn (x, y, z) to
 * (x, z, −y), a quarter turn about X. Fusion's XY plane becomes the ground
 * plane (`xz`) with the same in-plane axes, so sketches keep their own
 * coordinates. Everything a feature holds in the model's axes turns with it:
 * vectors, axes, planes, moves, primitive frames and the stored faces' surfaces.
 */
import { FaceIndex, type BrepFace, type BrepSurface, type FaceTag } from './parser/brep';
import type { F3dFeature, F3dLine3, F3dMatrix, F3dPlane } from './parser/types';
import { invertMatrix, multiplyMatrix, rotateByMatrix, type Vec3 } from './placement';

/** Row-major: (x, y, z) to (x, z, −y). */
export const Z_UP_TURN: F3dMatrix = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
const BACK = invertMatrix(Z_UP_TURN);

type V = [number, number, number];
const turned = (v: readonly [number, number, number]): V => rotateByMatrix(Z_UP_TURN, v as Vec3) as V;

/** Each origin plane as the one it turns into. */
const PLANES = { xy: 'xz', xz: 'xy', yz: 'yz' } as const;

function turnSurface(s: BrepSurface): BrepSurface {
  switch (s.kind) {
    case 'plane':
      return { ...s, origin: turned(s.origin), normal: turned(s.normal) };
    case 'cone':
      return { ...s, origin: turned(s.origin), axis: turned(s.axis) };
    case 'sphere':
      return { ...s, center: turned(s.center) };
    case 'torus':
      return { ...s, center: turned(s.center), axis: turned(s.axis) };
  }
}

/** Stored faces seen turned: the same faces, their surfaces in the turned axes. */
export class TurnedFaces extends FaceIndex {
  private readonly seen = new WeakMap<BrepFace, BrepFace>();

  constructor(private readonly inner: FaceIndex) {
    super();
  }

  override find(tag: FaceTag): BrepFace[] {
    return this.inner.find(tag).map((face) => {
      let out = this.seen.get(face);
      if (!out) {
        out = { ...face, surface: face.surface && turnSurface(face.surface) };
        this.seen.set(face, out);
      }
      return out;
    });
  }
}

const turnLine = (l: F3dLine3 | null): F3dLine3 | null =>
  l && { origin: turned(l.origin), direction: turned(l.direction) };
const turnPlane = (p: F3dPlane): F3dPlane => ({ origin: turned(p.origin), normal: turned(p.normal), x: turned(p.x) });

/** A feature with what it holds in the model's axes turned. */
export function turnFeature<T extends F3dFeature>(feature: T): T {
  return turnAny(feature) as T;
}

function turnAny(f: F3dFeature): F3dFeature {
  switch (f.kind) {
    case 'extrude':
      return { ...f, vector: turned(f.vector) };
    case 'revolve':
      return { ...f, axis: f.axis && { origin: turned(f.axis.origin), direction: turned(f.axis.direction) } };
    case 'move':
      // A rigid motion seen in the turned axes.
      return { ...f, matrix: f.matrix && multiplyMatrix(multiplyMatrix(Z_UP_TURN, f.matrix), BACK) };
    case 'mirror':
      return { ...f, plane: f.plane && PLANES[f.plane], frame: f.frame && turnPlane(f.frame) };
    case 'pattern':
      return { ...f, directions: f.directions.map(turnLine) };
    case 'primitive':
      return { ...f, plane: multiplyMatrix(Z_UP_TURN, f.plane) };
    default:
      return f;
  }
}
