/**
 * Captured contexts (12.4): other parts' geometry as an assembly placed it,
 * loaded into this part's frame. Each captured instance is stored in its own
 * part's frame with the names it had there, its `chain` extended by its
 * instance path; it is loaded there, checked against its shape map, then
 * moved by its captured placement, keeping its names. In-context references
 * resolve against this, never against the live assembly.
 */
import { NamedState, canonicalize, startFeature, type BodyOutcome } from '@tweakcad/format';
import {
  FeaturePause,
  cross,
  norm,
  scale,
  unit,
  type BuildContext,
  type ConstructionOutput,
  type Frame,
  type Json,
  type PartResult,
  type V3,
} from './context';
import { runMotion, type Motion } from './copies';
import { loadStored } from './builders/import';
import { apply, applyVector, readRigid, toFrame, type Rigid } from './rigid';
import { documentOf, emptyPart, mergeStates } from './variants';

/** What reading a context needs: the evaluation and the part it belongs to. */
type Where = Pick<BuildContext, 'ev' | 'part'>;

export interface LoadedContext {
  /** The context's row in its part. */
  row: Json;
  /** The captured geometry, named, in this part's frame. */
  place: PartResult;
  /** Each captured instance's placement in this part's frame, by its canonical instance path. */
  instances: Map<string, Rigid>;
}

/** The places contexts load into, so code reading a part can tell a context from a part. */
export const contextPlaces = new WeakSet<PartResult>();

const loaded = new WeakMap<object, Map<string, LoadedContext>>();

/** The id and row of the part `w` builds in this evaluation. */
export function partRowOf(w: Where): { id: string; row: Json } {
  for (const [id, part] of w.ev.parts) {
    if (part !== w.part) continue;
    const row = ((documentOf(w.ev).parts as Json[]) ?? []).find((p) => p.id === id);
    if (row) return { id, row };
  }
  throw new FeaturePause('in-context references are read only in a part of the document');
}

/** A placement `p → R·p + T` as a turn about the origin, then a shift. */
export function motionOf(p: Rigid): Motion {
  const [x, y, z, w] = p.rotation;
  const axis: V3 = [x, y, z];
  const sine = norm(axis);
  const motion: Motion = { shift: p.position };
  if (sine > 1e-15)
    motion.turn = { point: [0, 0, 0], direction: scale(axis, 1 / sine), radians: 2 * Math.atan2(sine, w) };
  return motion;
}

/** Any unit vector square to `d`. */
function across(d: V3): V3 {
  const helper: V3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(cross(d, helper));
}

/** A captured construction output's frame (12.4 `construction`). */
function frameOfGeometry(geometry: Json): { kind: ConstructionOutput['kind']; frame: Frame } {
  if ('plane' in geometry) {
    const g = geometry.plane as { origin: V3; normal: V3; x: V3 };
    return { kind: 'plane', frame: { origin: g.origin, x: g.x, y: cross(g.normal, g.x), normal: g.normal } };
  }
  if ('axis' in geometry) {
    const g = geometry.axis as { origin: V3; direction: V3 };
    const x = across(g.direction);
    return { kind: 'axis', frame: { origin: g.origin, x, y: cross(g.direction, x), normal: g.direction } };
  }
  if ('point' in geometry) {
    const at = (geometry.point as { at: V3 }).at;
    return { kind: 'point', frame: { origin: at, x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] } };
  }
  return { kind: 'frame', frame: toFrame(readRigid(geometry.frame)) };
}

const movedFrame = (p: Rigid, f: Frame): Frame => ({
  origin: apply(p, f.origin),
  x: applyVector(p, f.x),
  y: applyVector(p, f.y),
  normal: applyVector(p, f.normal),
});

function load(w: Where, part: string, row: Json): LoadedContext {
  const { ev } = w;
  const id = row.id as string;
  const place = emptyPart();
  contextPlaces.add(place);
  const instances = new Map<string, Rigid>();
  const owner = { feature: id, ordinal: -1 };
  ((row.captured as Json).set as Json[]).forEach((entry, j) => {
    const placement = readRigid(entry.placement);
    instances.set(canonicalize(entry.instance), placement);
    const own = emptyPart();
    const ctx = { ev, part: own, feature: row, inputs: {}, id, ordinal: -1 } as BuildContext;
    // Loaded where it was stored, so the shape map's load check holds; names already carry the instance path.
    const loading = startFeature(NamedState.empty(), owner, ev.adapter, ev.names);
    const stored = loadStored(ctx, loading, entry.stored as Json, `context:${part}:${id}:${j}`);
    own.state = loading.finish([]);
    own.shapes.set(stored.ref, stored.handle);
    // Then moved into this part's frame, keeping its names, as a move does.
    const moving = startFeature(own.state, owner, ev.adapter, ev.names);
    const { histories, moved } = runMotion(
      { ...ctx, part: own },
      { shape: stored.ref, handle: stored.handle },
      motionOf(placement),
    );
    for (const history of histories) moving.step(history, { outputs: [], dividers: [] });
    const outcomes: BodyOutcome[] = ev.adapter
      .topology(moved.shape)
      .solids.map((s) => ({ solid: s.solid, from: { carry: [stored.ref] } }));
    const state = histories.length > 0 ? moving.finish(outcomes) : own.state;
    place.state = mergeStates(place.state, state);
    place.shapes.set(moved.shape, moved.handle);
    ((entry.construction as Json[]) ?? []).forEach((c, i) => {
      const { kind, frame } = frameOfGeometry(c.geometry as Json);
      place.construction.set(`${j}:${i}`, {
        kind,
        frame: movedFrame(placement, frame),
        ladder: [...(c.ladder as string[])],
      });
    });
  });
  return { row, place, instances };
}

/** The captured context `id` of the part `w` builds, loaded once per evaluation. */
export function contextOf(w: Where, id: string): LoadedContext {
  const { id: part, row } = partRowOf(w);
  const key = `${part}|${id}`;
  let byPart = loaded.get(w.ev);
  if (!byPart) {
    byPart = new Map();
    loaded.set(w.ev, byPart);
  }
  const known = byPart.get(key);
  if (known) return known;
  const ctxRow = ((row.contexts as Json[]) ?? []).find((c) => c.id === id);
  if (!ctxRow) throw new FeaturePause(`the context ${id} is not in this part`);
  const made = load(w, part, ctxRow);
  byPart.set(key, made);
  return made;
}
