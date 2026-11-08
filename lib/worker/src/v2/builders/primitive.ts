/**
 * `core.primitive` (appendix A): a box, cylinder, sphere, cone or torus, centred
 * on its frame's origin with its axis along the frame's z. Width runs along x,
 * depth along y, height along z. Faces are named as the kernel makes them,
 * before placing, where their directions are exact; placing only carries names.
 */
import type { EvolutionData, ShapeHandle } from 'occt-wasm';
import {
  startFeature,
  type FeatureNamer,
  type OperationHistory,
  type ShapeKey,
  type ShapeRef,
  type SurfaceFacts,
} from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import {
  FeaturePause,
  LENGTH,
  add,
  kv,
  norm,
  registerBuilder,
  scale,
  sub,
  type BuildContext,
  type Frame,
  type Json,
  type V3,
} from '../context';
import { frameOf } from '../places';
import { applyOperation, type Live } from '../operation';

/** A shape as the kernel makes it, and where its centre lies. */
interface Made {
  handle: ShapeHandle;
  centre: V3;
}

function make(ctx: BuildContext, tag: string, fields: Json): Made {
  const { kernel: k, values } = ctx.ev;
  const length = (field: string, zero: 'refused' | 'allowed' = 'refused'): number => {
    const v = values.number(fields[field], LENGTH);
    if (v < 0 || (zero === 'refused' && v === 0)) throw new FeaturePause(`the ${tag} has a ${field} of ${v} mm`);
    return v;
  };
  switch (tag) {
    case 'box': {
      const [w, d, h] = [length('width'), length('depth'), length('height')];
      return { handle: k.makeBox(w, d, h), centre: [w / 2, d / 2, h / 2] };
    }
    case 'cylinder': {
      const [r, h] = [length('radius'), length('height')];
      return { handle: k.makeCylinder(r, h), centre: [0, 0, h / 2] };
    }
    case 'sphere':
      return { handle: k.makeSphere(length('radius')), centre: [0, 0, 0] };
    case 'cone': {
      const [bottom, top, h] = [length('bottomRadius', 'allowed'), length('topRadius', 'allowed'), length('height')];
      if (bottom === 0 && top === 0) throw new FeaturePause('the cone has no radius');
      // Equal radii are a cylinder, with the same roles.
      return { handle: bottom === top ? k.makeCylinder(bottom, h) : k.makeCone(bottom, top, h), centre: [0, 0, h / 2] };
    }
    case 'torus': {
      const [major, minor] = [length('majorRadius'), length('minorRadius')];
      if (minor >= major) throw new FeaturePause('the torus crosses itself: its minor radius reaches its axis');
      return { handle: k.makeTorus(major, minor), centre: [0, 0, 0] };
    }
    default:
      throw new FeaturePause(`a ${tag} has no naming rule yet`);
  }
}

/** The 9.4 role of a face of a fresh primitive, from its exact surface. */
function roleOf(tag: string, surface: SurfaceFacts): string | undefined {
  if (tag === 'box' && surface.kind === 'plane') {
    const axis = surface.normal.findIndex((c) => Math.abs(c) > 0.5);
    return `${(surface.normal[axis] as number) > 0 ? '+' : '-'}${'xyz'[axis] as string}`;
  }
  if (tag === 'cylinder' || tag === 'cone') {
    if (surface.kind === 'plane') return surface.normal[2] > 0 ? 'top' : 'bottom';
    if (surface.kind === 'cylinder' || surface.kind === 'cone') return 'wall';
  }
  if ((tag === 'sphere' && surface.kind === 'sphere') || (tag === 'torus' && surface.kind === 'torus'))
    return 'surface';
  return undefined;
}

/** The history of a shape made from nothing. */
function created(result: ShapeRef, faces: readonly ShapeKey[]): OperationHistory {
  const none = { kept: [], modified: new Map(), deleted: [], added: [] };
  return {
    result,
    inputs: [],
    faces: { ...none, added: faces },
    edges: none,
    facesFromFace: new Map(),
    facesFromEdge: new Map(),
  };
}

/** The rotation taking the part's axes onto `f`'s, as an axis and an angle in radians. */
function rotationOf(f: Frame): { axis: V3; angle: number } {
  const [m00, m10, m20] = f.x;
  const [m01, m11, m21] = f.y;
  const [m02, m12, m22] = f.normal;
  const trace = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = 2 * Math.sqrt(1 + trace);
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 >= m11 && m00 >= m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 >= m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const v = Math.hypot(q[0], q[1], q[2]);
  if (v < 1e-12) return { axis: [0, 0, 1], angle: 0 };
  return { axis: [q[0] / v, q[1] / v, q[2] / v], angle: 2 * Math.atan2(v, q[3]) };
}

/** Moves a named shape onto `frame`, its `centre` on the frame's origin; names carry through history. */
function place(ctx: BuildContext, namer: FeatureNamer, shape: Live, frame: Frame, centre: V3): Live {
  const { kernel: k, adapter } = ctx.ev;
  const carried = (evolution: EvolutionData, from: Live): Live => {
    const history = adapter.history(evolution, [{ shape: from.shape, use: 'target' }]);
    namer.step(history, { outputs: [], dividers: [] });
    return { shape: history.result, handle: evolution.result };
  };
  let at = shape;
  const { axis, angle } = rotationOf(frame);
  if (angle !== 0) {
    const turn = { point: kv([0, 0, 0]), direction: kv(axis) };
    at = carried(k.rotateWithHistory(at.handle, turn, angle, adapter.faceHashes([at.shape]), HASH_BOUND), at);
  }
  const inFrame = add(add(scale(frame.x, centre[0]), scale(frame.y, centre[1])), scale(frame.normal, centre[2]));
  const shift = sub(frame.origin, inFrame);
  if (norm(shift) !== 0) {
    at = carried(k.translateWithHistory(at.handle, ...shift, adapter.faceHashes([at.shape]), HASH_BOUND), at);
  }
  return at;
}

registerBuilder('core.primitive', (ctx) => {
  const { inputs, id, ordinal, part } = ctx;
  const { adapter, names } = ctx.ev;
  const shape = inputs.shape as Json;
  const tag = Object.keys(shape)[0] as string;
  const frame = frameOf(ctx, inputs.frame as Json);
  const { handle, centre } = make(ctx, tag, shape[tag] as Json);

  const ref = adapter.addShape(handle, `primitive:${id}`);
  const { faces } = adapter.topology(ref);
  const outputs = faces.map((entity) => {
    const role = roleOf(tag, adapter.faceGeometry(entity).surface);
    if (role === undefined) throw new FeaturePause(`a face of the ${tag} has no role`);
    return { entity, role, src: [] };
  });
  if (new Set(outputs.map((o) => o.role)).size !== outputs.length)
    throw new FeaturePause(`two faces of the ${tag} have one role`);

  const namer = startFeature(part.state, { feature: id, ordinal }, adapter, names);
  namer.step(created(ref, faces), { outputs, dividers: [] });
  const placed = place(ctx, namer, { shape: ref, handle }, frame, centre);
  applyOperation(ctx, namer, [{ ...placed, src: [{ index: 0 }] }], inputs.operation as Json);
});
