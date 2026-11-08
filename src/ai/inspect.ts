/**
 * The tools that read what the model is built into, from the newest
 * display and the worker service's measures (9.7): bodies, faces, edges,
 * vertices and construction geometry, each with a handle, and measures
 * between handles.
 */
import type { Json } from '@tweakcad/editor';
import type { BodyDisplay, Display, Key, MeasureKind, Vec3 } from '@tweakcad/worker/src/v2/service/types';
import { STANDARD_PLANES } from '../app/selection';
import { currentKey, entryOf, handleOf, num, round, roundVec, str, strings, type Args } from './common';
import { ToolError, invalid, partArg, settledDisplay, type AiContext } from './context';

const r3 = (v: readonly number[] | undefined): number[] | undefined => roundVec(v, 4);

function definitionOf(display: Display, part: string) {
  const index = display.parts[part];
  const definition = index === undefined ? undefined : display.definitions[index];
  if (!definition) throw new ToolError('NOT_FOUND', `The display does not show part ${part}`);
  return definition;
}

function boundsOf(mesh: BodyDisplay['mesh']): { min: number[]; max: number[] } | undefined {
  const p = mesh.positions;
  if (p.length < 3) return undefined;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = p[i + c] as number;
      if (v < (min[c] as number)) min[c] = v;
      if (v > (max[c] as number)) max[c] = v;
    }
  }
  return { min: r3(min) as number[], max: r3(max) as number[] };
}

export async function listBodies(ctx: AiContext, args: Args): Promise<Json> {
  const display = await settledDisplay(ctx);
  const part = partArg(ctx, args.part);
  const out: Json[] = [];
  for (const b of definitionOf(display, part).bodies) {
    const key = b.key;
    const handle = await handleOf(ctx, display, part, key, 'body', b.feature);
    const props = await ctx.client.properties(key);
    const volume = (props?.measures as { volume?: number } | undefined)?.volume;
    out.push({
      handle,
      name: b.name,
      feature: b.feature,
      ...(b.visible ? {} : { visible: false }),
      ...boundsOf(b.mesh),
      ...(volume !== undefined ? { volume: round(volume, 3) } : {}),
    });
  }
  return { part, bodies: out };
}

/** The shown body shape that holds a body key, with its part. */
async function bodyArg(
  ctx: AiContext,
  args: Args,
): Promise<{ display: Display; part: string; body: BodyDisplay; key: Key }> {
  const e = entryOf(ctx, args.body, ['body'], 'body');
  const display = await settledDisplay(ctx);
  const key = await currentKey(ctx, e, display);
  const body = definitionOf(display, e.part).bodies.find((b) => b.key === key);
  if (!body) throw new ToolError('NOT_FOUND', `${e.handle} is not shown`);
  // A hidden body is meshed once it shows; its faces and edges are listed from the mesh.
  if (body.unmeshed)
    throw new ToolError('REFUSED', `${e.handle} is hidden; show it to list its faces, edges and vertices`);
  return { display, part: e.part, body, key };
}

/** Triples `[first, count, key]` of a mesh table. */
function triples(table: Uint32Array): [number, number, Key][] {
  const out: [number, number, Key][] = [];
  for (let i = 0; i + 2 < table.length; i += 3)
    out.push([table[i] as number, table[i + 1] as number, table[i + 2] as number]);
  return out;
}

const dot = (a: readonly number[], b: readonly number[]) =>
  (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number);

function unit(v: readonly number[]): number[] {
  const l = Math.hypot(v[0] as number, v[1] as number, v[2] as number);
  if (!(l > 0)) throw invalid('A direction is not [0, 0, 0]');
  return v.map((x) => x / l);
}

function directionArg(args: Args, field: string): number[] | undefined {
  const v = args[field];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number'))
    throw invalid(`\`${field}\` is [x, y, z]`);
  return unit(v as number[]);
}

const COS_1_DEG = Math.cos(Math.PI / 180);

export async function listFaces(ctx: AiContext, args: Args): Promise<Json> {
  const { display, part, body } = await bodyArg(ctx, args);
  const surface = args.surface === undefined ? undefined : str(args, 'surface');
  const normal = directionArg(args, 'normal');
  const out: Json[] = [];
  for (const [, , key] of triples(body.mesh.faces)) {
    const props = await ctx.client.properties(key);
    const m = props?.measures as
      | (Record<string, unknown> & {
          surface?: string;
          normal?: number[];
          axis?: number[];
          centroid?: number[];
          area?: number;
        })
      | undefined;
    if (!m) continue;
    if (surface !== undefined && m.surface !== surface) continue;
    if (normal && !(m.normal && dot(m.normal, normal) >= COS_1_DEG)) continue;
    const handle = await handleOf(ctx, display, part, key, 'face', display.entities[key]?.feature ?? '');
    let radius: number | undefined;
    if (m.surface === 'cylinder' || m.surface === 'sphere') {
      const measured = await ctx.client.measure('radius', [key]);
      if ('value' in measured) radius = round(measured.value, 4);
    }
    out.push({
      handle,
      surface: m.surface,
      area: m.area !== undefined ? round(m.area, 3) : undefined,
      centroid: r3(m.centroid),
      ...(m.normal ? { normal: r3(m.normal) } : {}),
      ...(m.axis ? { axis: r3(m.axis) } : {}),
      ...(radius !== undefined ? { radius } : {}),
      feature: display.entities[key]?.feature,
    });
  }
  return { faces: out };
}

/** For each shown edge of a body, the faces whose triangles hold every point of its polyline. */
function edgeFaces(body: BodyDisplay): Map<Key, Key[]> {
  const m = body.mesh;
  const at = (i: number) =>
    `${Math.round((m.positions[3 * i] as number) * 1e4)},${Math.round((m.positions[3 * i + 1] as number) * 1e4)},${Math.round((m.positions[3 * i + 2] as number) * 1e4)}`;
  const facesAt = new Map<string, Set<Key>>();
  for (const [first, count, face] of triples(m.faces)) {
    for (let t = first; t < first + count; t++) {
      for (let c = 0; c < 3; c++) {
        const k = at(m.indices[3 * t + c] as number);
        let set = facesAt.get(k);
        if (!set) facesAt.set(k, (set = new Set()));
        set.add(face);
      }
    }
  }
  const seg = (i: number) =>
    `${Math.round((m.segments[3 * i] as number) * 1e4)},${Math.round((m.segments[3 * i + 1] as number) * 1e4)},${Math.round((m.segments[3 * i + 2] as number) * 1e4)}`;
  const out = new Map<Key, Key[]>();
  for (const [first, count, edge] of triples(m.edges)) {
    const counts = new Map<Key, number>();
    const points = new Set<string>();
    for (let s = first; s < first + count; s++) for (const p of [2 * s, 2 * s + 1]) points.add(seg(p));
    for (const p of points) for (const f of facesAt.get(p) ?? []) counts.set(f, (counts.get(f) ?? 0) + 1);
    const all = [...counts].filter(([, n]) => n === points.size).map(([f]) => f);
    out.set(edge, all.length > 0 ? all : [...counts].filter(([, n]) => n * 2 >= points.size).map(([f]) => f));
  }
  return out;
}

/** The two ends of an edge's polyline. */
function endsOf(body: BodyDisplay, first: number, count: number): [number[], number[]] {
  const s = body.mesh.segments;
  const p = (i: number) => [s[3 * i] as number, s[3 * i + 1] as number, s[3 * i + 2] as number];
  return [p(2 * first), p(2 * (first + count - 1) + 1)];
}

export async function listEdges(ctx: AiContext, args: Args): Promise<Json> {
  const { display, part, body } = await bodyArg(ctx, args);
  const adjacency = edgeFaces(body);
  const faceKey = async (h: unknown, field: string) => currentKey(ctx, entryOf(ctx, h, ['face'], field), display);
  const ofFace = args.face === undefined ? undefined : await faceKey(args.face, 'face');
  const between =
    args.between === undefined
      ? undefined
      : await Promise.all((strings(args, 'between') as string[]).map((h, i) => faceKey(h, `between[${i}]`)));
  if (between && between.length !== 2) throw invalid('`between` takes two face handles');
  const curve = args.curve === undefined ? undefined : str(args, 'curve');
  const parallel = directionArg(args, 'parallel');
  const minLength = args.minLength === undefined ? undefined : num(args, 'minLength');
  const maxLength = args.maxLength === undefined ? undefined : num(args, 'maxLength');
  const faceHandle = async (key: Key) =>
    (await handleOf(ctx, display, part, key, 'face', display.entities[key]?.feature ?? '')) ?? undefined;
  const out: Json[] = [];
  for (const [first, count, key] of triples(body.mesh.edges)) {
    const faces = adjacency.get(key) ?? [];
    if (ofFace !== undefined && !faces.includes(ofFace)) continue;
    if (between && !(between.every((f) => faces.includes(f)) && faces.length === 2)) continue;
    const props = await ctx.client.properties(key);
    const m = props?.measures as
      | (Record<string, unknown> & {
          curve?: string;
          length?: number;
          center?: number[];
          midpoint?: number[];
          tangent?: number[];
        })
      | undefined;
    if (!m) continue;
    if (curve !== undefined && m.curve !== curve) continue;
    if (minLength !== undefined && !((m.length ?? 0) >= minLength - 1e-6)) continue;
    if (maxLength !== undefined && !((m.length ?? Infinity) <= maxLength + 1e-6)) continue;
    const [start, end] = endsOf(body, first, count);
    if (parallel) {
      if (m.curve !== 'line') continue;
      const d = unit(end.map((v, i) => v - (start[i] as number)));
      if (Math.abs(dot(d, parallel)) < COS_1_DEG) continue;
    }
    let radius: number | undefined;
    if (m.curve === 'circle') {
      const measured = await ctx.client.measure('radius', [key]);
      if ('value' in measured) radius = round(measured.value, 4);
    }
    out.push({
      handle: await handleOf(ctx, display, part, key, 'edge', display.entities[key]?.feature ?? ''),
      curve: m.curve,
      length: m.length !== undefined ? round(m.length, 4) : undefined,
      start: r3(start),
      end: r3(end),
      ...(m.midpoint ? { midpoint: r3(m.midpoint) } : {}),
      ...(m.center ? { center: r3(m.center) } : {}),
      ...(radius !== undefined ? { radius } : {}),
      faces: await Promise.all(faces.map(faceHandle)),
    });
  }
  return { edges: out };
}

export async function listVertices(ctx: AiContext, args: Args): Promise<Json> {
  const { display, part, body } = await bodyArg(ctx, args);
  const out: Json[] = [];
  const { points, vertices } = body.mesh;
  for (let i = 0; i < vertices.length; i++) {
    const key = vertices[i] as Key;
    out.push({
      handle: await handleOf(ctx, display, part, key, 'vertex', display.entities[key]?.feature ?? ''),
      at: r3([points[3 * i] as number, points[3 * i + 1] as number, points[3 * i + 2] as number]),
    });
  }
  return { vertices: out };
}

const frameOf = (f: { origin: Vec3; x: Vec3; y: Vec3; normal: Vec3 }): Json => ({
  origin: r3(f.origin),
  x: r3(f.x),
  y: r3(f.y),
  normal: r3(f.normal),
});

const STANDARD_FRAMES: Record<string, { origin: Vec3; x: Vec3; y: Vec3; normal: Vec3 }> = {
  xy: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] },
  xz: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, -1], normal: [0, 1, 0] },
  yz: { origin: [0, 0, 0], x: [0, 0, -1], y: [0, 1, 0], normal: [1, 0, 0] },
};

export async function listConstruction(ctx: AiContext, args: Args): Promise<Json> {
  const display = await settledDisplay(ctx);
  const part = partArg(ctx, args.part);
  const out: Json[] = STANDARD_PLANES.map((name) => ({
    handle: name,
    kind: 'plane',
    standard: true,
    frame: frameOf(STANDARD_FRAMES[name] as (typeof STANDARD_FRAMES)['xy']),
  }));
  for (const name of ['x', 'y', 'z']) out.push({ handle: name, kind: 'axis', standard: true });
  for (const c of definitionOf(display, part).construction) {
    out.push({
      handle: await handleOf(ctx, display, part, c.key, 'construction', c.feature),
      kind: c.kind,
      feature: c.feature,
      frame: frameOf(c.frame),
    });
  }
  return { part, construction: out };
}

const MEASURES: readonly MeasureKind[] = ['distance', 'length', 'area', 'volume', 'angle', 'radius'];

export async function measure(ctx: AiContext, args: Args): Promise<Json> {
  const kind = str(args, 'kind') as MeasureKind;
  if (!MEASURES.includes(kind)) throw invalid(`\`kind\` is one of ${MEASURES.join(', ')}`);
  const display = await settledDisplay(ctx);
  const keys: Key[] = [];
  for (const [i, h] of (strings(args, 'entities') as string[]).entries()) {
    keys.push(
      await currentKey(
        ctx,
        entryOf(ctx, h, ['body', 'face', 'edge', 'vertex', 'curve', 'point', 'construction'], `entities[${i}]`),
        display,
      ),
    );
  }
  const result = await ctx.client.measure(kind, keys);
  if ('pause' in result) throw new ToolError('REFUSED', result.pause);
  return { value: round(result.value, 6), quantity: result.quantity };
}
