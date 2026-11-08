/**
 * Assemblies (chapter 12): instances of parts, assemblies and library
 * components, each a variant build (12.1) placed by its stored placement;
 * the assembly timeline's copies; joint origins, joints and relations; the
 * pose solve (12.2); positions and exploded views as data.
 *
 * Every placed instance or copy is a **node**, named by its instance path
 * (9.1). Its entities carry the path's steps in their `chain` (9.5), so a
 * reference into an instance names the node it lies in, and resolves among
 * that node's entities in the node's own frame. Frames attached to a node's
 * geometry are read in that frame, so a joint is the same whatever the
 * node's placement. The assembly's result holds every node at its solved
 * placement, named through its path, for references from outside and for
 * an assembly or part that inserts this one.
 */
import { OcctError } from 'occt-wasm';
import {
  NamingPause,
  ValuePause,
  canonicalize,
  finest,
  type CopyStep,
  type EntityRecord,
  type ShapeRef,
} from '@tweakcad/format';
import { NamingAdapterError } from '@tweakcad/kernel/src/namingAdapter.ts';
import {
  ANGLE,
  FLAG,
  FeaturePause,
  INTEGER,
  LENGTH,
  PLACEMENT,
  type Evaluation,
  type Json,
  type PartResult,
  type V3,
} from './context';
import { circularTurns, sideIndices } from './layoutSlots';
import { STANDARD, axisOf, directionOf, entityOf, frameOf, type Where } from './places';
import { solvePose, type JointEnd, type SolveJoint, type SolveNode, type SolveRelation } from './poseSolve';
import {
  IDENTITY,
  apply,
  applyVector,
  compose,
  fromFrame,
  inverse,
  mirrored,
  qaxis,
  readRigid,
  type Plane,
  type Rigid,
} from './rigid';
import { SketchSolvePause } from './sketchSolve';
import {
  emptyPart,
  ensureAssembly,
  instanceStep,
  placeInto,
  registerAssemblyBuilder,
  stepsOfPath,
  variantOf,
  type Placeable,
  type Variant,
} from './variants';
import { deriveRecordsOf } from './deriveRecords';

/** A placed instance or copy. */
export interface AssemblyNode {
  /** Its instance path (9.1), outermost first. */
  path: Json;
  /** The path as chain steps (9.5), innermost first. */
  steps: CopyStep[];
  /** The steps, canonical: one per node. */
  key: string;
  /** The instance row it comes from; a copy's is its seed's. */
  instance: string;
  /** The build it places. */
  variant: Variant;
  /** Its placement before the solve: an instance's stored one, or where its feature puts a copy of its seed. */
  stored: Rigid;
  /** Its placement after the solve (12.2). */
  placement: Rigid;
  /** Its bodies in the assembly's result. */
  shapes: ShapeRef[];
}

export interface AssemblyResult extends PartResult {
  id: string;
  /** Instances first, in table order, then copies in timeline order. */
  nodes: AssemblyNode[];
  /** Each solved joint's values by degree of freedom (mm, deg): the `state` to write back. */
  joints: Map<string, Record<string, number>>;
  /** Each solved joint's end frames in the assembly after the solve: `b` is `a` moved by the joint's values. */
  jointFrames: Map<string, { a: Rigid; b: Rigid }>;
  /** The saved positions (12.1), and the one the solve used, if any. */
  positions: { id: string; name: string; state: Record<string, Record<string, number>> }[];
  activePosition: string | null;
  /** Each exploded view's placements of the nodes it moves, by node key. */
  exploded: Map<string, Map<string, Rigid>>;
}

/** Joint kinds and their degrees of freedom (12.1). */
const JOINT_DOFS: Record<string, readonly string[]> = {
  rigid: [],
  revolute: ['rz'],
  slider: ['tz'],
  cylindrical: ['tz', 'rz'],
  pinSlot: ['tx', 'rz'],
  planar: ['tx', 'ty', 'rz'],
  ball: ['rz', 'ry', 'rx'],
};

const LEAD = { type: 'number', quantity: 'lead' } as const;
const RATIO_VALUE = { type: 'number', quantity: 'ratio' } as const;

/** Why something did not build, or undefined for an error that is not a pause. */
function pauseMessage(e: unknown): string | undefined {
  if (e instanceof FeaturePause || e instanceof ValuePause || e instanceof SketchSolvePause || e instanceof NamingPause)
    return e.message;
  if (e instanceof NamingAdapterError && e.code === 'collision') return `two sub-shapes share a hash: ${e.message}`;
  if (e instanceof OcctError) return `the kernel could not build it: ${e.message}`;
  return undefined;
}

interface Node extends AssemblyNode {
  grounded: boolean;
  /** A copy follows its seed. */
  copy?: { seed: Node; follow: (seed: Rigid) => Rigid; unfollow: (copy: Rigid) => Rigid };
}

/** Every entity record under `v`, and whether a default geometry reference is among them. */
function referencesIn(v: unknown, out: { records: EntityRecord[]; standard: boolean }): typeof out {
  if (Array.isArray(v)) v.forEach((x) => referencesIn(x, out));
  else if (v !== null && typeof v === 'object') {
    const o = v as Json;
    if (o.entity && typeof o.entity === 'object' && Array.isArray((o.entity as Json).id))
      out.records.push(o.entity as EntityRecord);
    else if (o.standard && typeof o.standard === 'object') out.standard = true;
    else for (const [k, x] of Object.entries(o)) if (k !== 'extensions') referencesIn(x, out);
  }
  return out;
}

function buildAssembly(ev: Evaluation, asm: Json): AssemblyResult {
  const id = asm.id as string;
  const { values } = ev;
  const flag = (v: unknown) => values.literal(v, FLAG) === true;
  const pause = (row: string, e: unknown) => {
    const message = pauseMessage(e);
    if (message === undefined) throw e;
    ev.pauses.push({ feature: row, message });
  };
  const nodes = new Map<string, Node>();
  const ordered: Node[] = [];
  const add = (node: Node) => {
    if (nodes.has(node.key)) throw new FeaturePause('two copies have the same instance path');
    nodes.set(node.key, node);
    ordered.push(node);
  };

  // Instances, each placing a variant of its definition.
  for (const row of asm.instances as Json[]) {
    const inst = row.id as string;
    try {
      if (flag(row.suppressed)) continue;
      const variant = variantOf(ev, row.of as Json, row.overrides as Json[], inst);
      const steps = [instanceStep(inst)];
      const stored = readRigid(row.placement);
      add({
        path: { path: [{ instance: { id: inst } }] },
        steps,
        key: canonicalize(steps),
        instance: inst,
        variant,
        stored,
        placement: stored,
        shapes: [],
        grounded: flag(row.grounded),
      });
    } catch (e) {
      pause(inst, e);
    }
  }

  // A node's geometry in its own frame, named through its path; cached by build and steps.
  const views = new Map<string, PartResult>();
  const view = (variant: Variant, steps: readonly CopyStep[]): PartResult => {
    const key = `${variant.key}|${canonicalize(steps)}`;
    const known = views.get(key);
    if (known) return known;
    const made = emptyPart();
    const inner = steps.length === 1 ? variant.result : view(variant, steps.slice(0, -1));
    placeInto(ev, made, inner, { rigid: IDENTITY }, steps[steps.length - 1] as CopyStep, { feature: id, ordinal: 0 });
    views.set(key, made);
    return made;
  };
  const ground = emptyPart();
  const whereOf = (node: Node | null): Where => ({ ev, part: node ? view(node.variant, node.steps) : ground });

  /** The node an entity record lies in: its chain ends with the node's steps, up to the outermost instance step. */
  const nodeOfRecord = (record: EntityRecord): Node => {
    const level = ev.names.get(finest(record.id)) as Json | undefined;
    const chain = (level?.chain as CopyStep[] | undefined) ?? [];
    let start = chain.length - 1;
    while (start >= 0 && !('instance' in ((chain[start] as CopyStep).key as Json))) start--;
    const node = start < 0 ? undefined : nodes.get(canonicalize(chain.slice(start)));
    if (!node) throw new FeaturePause('a reference names geometry of no placed instance');
    return node;
  };
  /** The one node, or the assembly itself (null), that the references under `v` lie in. */
  const nodeOf = (v: unknown): Node | null => {
    const { records, standard } = referencesIn(v, { records: [], standard: false });
    const found = new Set(records.map(nodeOfRecord));
    if (found.size + (standard ? 1 : 0) > 1)
      throw new FeaturePause('a frame is attached to the geometry of several instances');
    return found.size === 1 ? ([...found][0] as Node) : null;
  };
  const nodeAt = (path: Json): Node => {
    const node = nodes.get(canonicalize(stepsOfPath(path)));
    if (!node) throw new FeaturePause('an instance path names no placed instance');
    return node;
  };
  /** An attached frame, in the frame of the node it is attached to. */
  const frameEnd = (frame: Json): { node: Node | null; frame: Rigid } => {
    const node = nodeOf(frame);
    return { node, frame: fromFrame(frameOf(whereOf(node), frame)) };
  };
  const world = (node: Node | null, p: Rigid) => (node ? compose(node.stored, p) : p);
  const members = (set: unknown): Json[] => ((set as Json | undefined)?.set as Json[] | undefined) ?? [];

  const addCopy = (
    seed: Node,
    step: CopyStep,
    follow: (p: Rigid) => Rigid,
    unfollow: (p: Rigid) => Rigid,
    variant = seed.variant,
  ) => {
    const steps = [...seed.steps, step];
    const stored = follow(seed.stored);
    add({
      path: { path: [{ copy: step }, ...((seed.path.path as Json[]) ?? [])] },
      steps,
      key: canonicalize(steps),
      instance: seed.instance,
      variant,
      stored,
      placement: stored,
      shapes: [],
      grounded: false,
      copy: { seed, follow, unfollow },
    });
  };

  // The assembly timeline: features that create copies of instances.
  for (const feature of (asm.timeline as Json[]) ?? []) {
    const fid = feature.id as string;
    try {
      if (flag(feature.suppressed)) continue;
      if ('frozen' in (feature.frozen as Json)) throw new FeaturePause('an assembly feature cannot be frozen');
      if (values.inputOverrides.some((o) => o.feature === fid)) {
        throw new FeaturePause('configuration input overrides of assembly features are not built yet');
      }
      const inputs = feature.inputs as Json;
      const seeds = members(inputs.of).map(nodeAt);
      const shifted = (t: Rigid) => ({
        follow: (p: Rigid) => compose(t, p),
        unfollow: (p: Rigid) => compose(inverse(t), p),
      });
      switch (feature.type) {
        case 'core.asm.pattern': {
          const skip = new Set(
            members(inputs.skip).map((k) => `${String((k.slot as Json).i)},${String((k.slot as Json).j)}`),
          );
          for (const { i, j, t } of layoutTransforms(ev, inputs.layout as Json, (v) => nodeOf(v), whereOf)) {
            if ((i === 0 && j === 0) || skip.has(`${i},${j}`)) continue;
            const { follow, unfollow } = shifted(t);
            for (const seed of seeds) addCopy(seed, { op: { id: fid }, key: { slot: { i, j } } }, follow, unfollow);
          }
          break;
        }
        case 'core.asm.mirror': {
          const plane = mirrorPlane(ev, inputs.plane as Json, nodeOf, whereOf);
          const step: CopyStep = { op: { id: fid }, key: { mirror: {} } };
          const hand = inputs.hand as Json;
          for (const seed of seeds) {
            if ('same' in hand) {
              // The seed's own axis nearest the mirror's normal is reflected too, so the copy stays its definition, turned (12.1).
              const local = applyVector(inverse(seed.stored), plane.normal);
              const k = [0, 1, 2].reduce(
                (best, c) => (Math.abs(local[c] as number) > Math.abs(local[best] as number) ? c : best),
                0,
              );
              const axis: V3 = [0, 0, 0];
              axis[k] = 1;
              const own: Plane = { point: [0, 0, 0], normal: axis };
              const turn = (p: Rigid) => mirrored(plane, p, own);
              addCopy(seed, step, turn, turn);
              continue;
            }
            const rows = ((hand.opposite as Json).parts as Json[]) ?? [];
            const row = rows.find((r) => canonicalize(stepsOfPath(r.instance as Json)) === seed.key);
            if (!row) throw new FeaturePause('an opposite-hand mirror has no part for one of its instances');
            const variant = variantOf(ev, { part: row.part as Json }, [], fid);
            const record = deriveRecordsOf(variant.result).find((d) => d.mirror !== undefined);
            if (!record?.mirror) throw new FeaturePause('the opposite-hand part has no mirrored derive');
            const { frame, mirror } = record;
            addCopy(
              seed,
              step,
              (p) => mirrored(plane, compose(p, inverse(frame)), mirror),
              (c) => compose(mirrored(plane, c, mirror), frame),
              variant,
            );
          }
          break;
        }
        case 'core.asm.replicate': {
          const seedEnd = frameEnd(inputs.seed as Json);
          const from = world(seedEnd.node, seedEnd.frame);
          (inputs.targets as Json[]).forEach((target, k) => {
            const end = frameEnd(target);
            const { follow, unfollow } = shifted(compose(world(end.node, end.frame), inverse(from)));
            for (const seed of seeds)
              addCopy(seed, { op: { id: fid }, key: { slot: { i: k + 1, j: 0 } } }, follow, unfollow);
          });
          break;
        }
        default:
          throw new FeaturePause(`${String(feature.type)} is not an assembly feature that is built`);
      }
    } catch (e) {
      pause(fid, e);
    }
  }

  // Joint origins, in the frame of the node each lies on.
  const origins = new Map<string, { node: Node | null; frame: Rigid }>();
  for (const row of (asm.jointOrigins as Json[]) ?? []) {
    try {
      origins.set(row.id as string, frameEnd(row.frame as Json));
    } catch (e) {
      pause(row.id as string, e);
    }
  }

  // The active position replaces joint states before the solve (12.2).
  const active =
    'position' in (asm.activePosition as Json) ? (((asm.activePosition as Json).position as Json).id as string) : null;
  const positionRows = ((asm.positions as Json[]) ?? []).map((p) => ({
    id: p.id as string,
    name: p.name as string,
    state: p.state as Record<string, Record<string, number>>,
  }));
  const activeState = active === null ? undefined : positionRows.find((p) => p.id === active)?.state;

  // Bodies: an instance, or every member of a rigid group.
  const instances = ordered.filter((n) => !n.copy);
  const groupOf = new Map<Node, number>(instances.map((n, i) => [n, i]));
  const find = (i: number): number => {
    let r = i;
    while (groupOf.get(instances[r] as Node) !== r) r = groupOf.get(instances[r] as Node) as number;
    return r;
  };
  for (const group of (asm.rigidGroups as Json[]) ?? []) {
    try {
      const inGroup = members(group.members).map(nodeAt);
      if (inGroup.some((n) => n.copy)) throw new FeaturePause('a rigid group of assembly copies is not built yet');
      const [first, ...rest] = inGroup.map((n) => find(groupOf.get(n) as number));
      for (const r of rest) if (first !== undefined) groupOf.set(instances[r] as Node, first);
    } catch (e) {
      pause(group.id as string, e);
    }
  }
  const roots = [...new Set(instances.map((_, i) => find(i)))];
  const bodyIndex = new Map(roots.map((r, b) => [r, b]));
  const bodies = roots.map((r) => ({
    stored: (instances[r] as Node).stored,
    grounded: instances.some((n, i) => find(i) === r && n.grounded),
  }));
  const nodeIndex = new Map(ordered.map((n, i) => [n, i]));
  const solveNodes: SolveNode[] = ordered.map((n) => {
    if (n.copy) return { seed: nodeIndex.get(n.copy.seed) as number, follow: n.copy.follow, unfollow: n.copy.unfollow };
    const root = find(groupOf.get(n) as number);
    return {
      body: bodyIndex.get(root) as number,
      offset: compose(inverse((instances[root] as Node).stored), n.stored),
    };
  });

  // Joints an attribute locks (16.1) hold where their `state` puts them: the active position does not move them, nor does the solve.
  const locked = new Set<string>();
  for (const a of (asm.attributes as Json[]) ?? []) {
    const joint = ((a.target as Json | undefined)?.object as Json | undefined)?.joint as Json | undefined;
    const lock = (a.properties as Json | undefined)?.locked;
    if (!joint || typeof joint.id !== 'string' || lock === undefined) continue;
    try {
      if (flag(lock)) locked.add(joint.id);
    } catch (e) {
      pause(a.id as string, e);
    }
  }

  // Joints.
  const joints: SolveJoint[] = [];
  const jointRows: Json[] = [];
  for (const row of (asm.joints as Json[]) ?? []) {
    const jid = row.id as string;
    try {
      if (flag(row.suppressed)) continue;
      const held = locked.has(jid);
      const dofs = JOINT_DOFS[row.kind as string];
      if (!dofs) throw new FeaturePause(`a ${String(row.kind)} joint is not built yet`);
      const end = (e: Json): JointEnd => {
        let at: { node: Node | null; frame: Rigid };
        if ('origin' in e) {
          const o = origins.get(((e.origin as Json).id as string) ?? '');
          if (!o) throw new FeaturePause('the joint origin did not build');
          at = o;
        } else at = frameEnd(e.frame as Json);
        return { node: at.node ? (nodeIndex.get(at.node) as number) : null, frame: at.frame };
      };
      const a = end(row.a as Json);
      const b = end(row.b as Json);
      const state = { ...(row.state as Record<string, number>), ...(held ? {} : (activeState?.[jid] ?? {})) };
      const rest = row.rest as Json;
      const target = (dof: string) => (dof.startsWith('r') ? ANGLE : LENGTH);
      const start = dofs.map(
        (dof) => state[dof] ?? (rest[dof] !== undefined ? values.number(rest[dof], target(dof)) : 0),
      );
      const limits = dofs.map((dof): [number, number] | null => {
        const limit = (row.limits as Json)[dof] as Json | undefined;
        if (!limit || !('between' in limit)) return null;
        const between = limit.between as Json;
        const range: [number, number] = [
          values.number(between.min, target(dof)),
          values.number(between.max, target(dof)),
        ];
        if (range[0] > range[1]) throw new FeaturePause(`the ${dof} limits of the joint are the wrong way round`);
        return range;
      });
      if (held) {
        // A locked joint stays at its start, within its limits, as a rigid joint would.
        const at = start.map((v, k) => {
          const l = limits[k];
          return l ? Math.min(Math.max(v, l[0]), l[1]) : v;
        });
        joints.push({ id: jid, dofs, a, b, start: at, limits: at.map((v): [number, number] => [v, v]) });
      } else joints.push({ id: jid, dofs, a, b, start, limits });
      jointRows.push(row);
    } catch (e) {
      pause(jid, e);
    }
  }

  // Relations between joints.
  const relations: SolveRelation[] = [];
  for (const row of (asm.relations as Json[]) ?? []) {
    const rid = row.id as string;
    try {
      const listed = (row.joints as string[]).map((j) => {
        const index = joints.findIndex((s) => s.id === j);
        if (index < 0) throw new FeaturePause('a joint of the relation is not solved');
        return index;
      });
      const only = (joint: number, prefix: 'r' | 't') => {
        const dofs = (joints[joint] as SolveJoint).dofs;
        const found = dofs.flatMap((d, i) => (d.startsWith(prefix) ? [i] : []));
        if (found.length !== 1)
          throw new FeaturePause(
            `a ${String(jointRows[joint]?.kind)} joint is the wrong kind for a ${String(row.kind)} relation`,
          );
        return { joint, dof: found[0] as number };
      };
      const count = (n: number) => {
        if (listed.length !== n)
          throw new FeaturePause(`a ${String(row.kind)} relation takes ${n} joint${n === 1 ? '' : 's'}`);
      };
      switch (row.kind) {
        case 'gear':
          count(2);
          relations.push({
            id: rid,
            a: only(listed[0] as number, 'r'),
            b: only(listed[1] as number, 'r'),
            ratio: values.number(row.ratio, RATIO_VALUE),
          });
          break;
        case 'rackPinion':
          count(2);
          relations.push({
            id: rid,
            a: only(listed[0] as number, 'r'),
            b: only(listed[1] as number, 't'),
            ratio: values.number(row.ratio, LEAD),
          });
          break;
        case 'screw': {
          count(1);
          const joint = listed[0] as number;
          if (jointRows[joint]?.kind !== 'cylindrical')
            throw new FeaturePause('a screw relation takes a cylindrical joint');
          relations.push({ id: rid, a: only(joint, 'r'), b: only(joint, 't'), ratio: values.number(row.ratio, LEAD) });
          break;
        }
        default:
          throw new FeaturePause(`a ${String(row.kind)} relation is not built yet`);
      }
    } catch (e) {
      pause(rid, e);
    }
  }

  const solved = solvePose({ bodies, nodes: solveNodes, joints, relations });
  for (const unsatisfied of solved.unsatisfied) {
    ev.pauses.push({
      feature: unsatisfied,
      message: 'the joints cannot all hold: the loop does not close within its limits',
    });
  }
  ordered.forEach((n, i) => {
    n.placement = solved.placements[i] as Rigid;
  });

  // Every node at its solved placement, named through its path.
  const result: AssemblyResult = {
    ...emptyPart(),
    id,
    nodes: ordered,
    joints: new Map(
      joints.map((j, i) => [
        j.id,
        Object.fromEntries(j.dofs.map((d, k) => [d, (solved.values[i] as number[])[k] as number])),
      ]),
    ),
    jointFrames: new Map(
      joints.map((j) => {
        const end = (e: JointEnd) => (e.node === null ? e.frame : compose(solved.placements[e.node] as Rigid, e.frame));
        return [j.id, { a: end(j.a), b: end(j.b) }];
      }),
    ),
    positions: positionRows,
    activePosition: active,
    exploded: new Map(),
  };
  ordered.forEach((n, ordinal) => {
    try {
      const source: Placeable = n.steps.length === 1 ? n.variant.result : view(n.variant, n.steps.slice(0, -1));
      const placed = placeInto(ev, result, source, { rigid: n.placement }, n.steps[n.steps.length - 1] as CopyStep, {
        feature: id,
        ordinal,
      });
      n.shapes = placed.map((p) => p.shape);
    } catch (e) {
      pause(n.instance, e);
    }
  });

  // Exploded views: data only, each step moving its instances further.
  for (const exp of (asm.explodedViews as Json[]) ?? []) {
    const moved = new Map<string, Rigid>();
    try {
      for (const step of exp.steps as Json[]) {
        const t = readRigid(values.literal(step.transform, PLACEMENT));
        for (const path of members(step.instances)) {
          const node = nodeAt(path);
          moved.set(node.key, compose(t, moved.get(node.key) ?? node.placement));
        }
      }
      result.exploded.set(exp.id as string, moved);
    } catch (e) {
      pause(exp.id as string, e);
    }
  }
  ev.assemblies.set(id, result);
  return result;
}

/** Each slot of a pattern layout and its transform in the assembly (12.1, appendix A layouts). */
function layoutTransforms(
  ev: Evaluation,
  layout: Json,
  nodeOf: (v: unknown) => Node | null,
  whereOf: (node: Node | null) => Where,
): { i: number; j: number; t: Rigid }[] {
  const { values } = ev;
  const count = (v: unknown) => {
    const n = values.number(v, INTEGER);
    if (n < 1) throw new FeaturePause('a pattern counts at least its seed');
    return n;
  };
  if ('linear' in layout) {
    const rows = ((layout.linear as Json).directions as Json[]).map((d) => {
      const spacing = d.spacing as Json;
      if (!('equal' in spacing)) throw new FeaturePause('listed spacing is not settled yet');
      const node = nodeOf(d.direction);
      const local = directionOf(whereOf(node), d.direction as Json);
      const symmetric = d.symmetric !== undefined && values.literal(d.symmetric, FLAG) === true;
      return {
        indices: sideIndices(count(d.count), symmetric),
        s: values.number((spacing.equal as Json).s, LENGTH),
        d: node ? applyVector(node.stored, local) : local,
      };
    });
    const [first, second = { indices: [0], s: 0, d: [0, 0, 0] as V3 }] = rows as [
      (typeof rows)[number],
      (typeof rows)[number]?,
    ];
    const out: { i: number; j: number; t: Rigid }[] = [];
    for (const i of first.indices) {
      for (const j of second.indices) {
        const position = [0, 1, 2].map(
          (c) => i * first.s * (first.d[c] as number) + j * second.s * (second.d[c] as number),
        ) as V3;
        out.push({ i, j, t: { position, rotation: [0, 0, 0, 1] } });
      }
    }
    return out;
  }
  if ('circular' in layout) {
    const c = layout.circular as Json;
    const node = nodeOf(c.axis);
    const line = axisOf(whereOf(node), c.axis as Json);
    const point = node ? apply(node.stored, line.point) : line.point;
    const direction = node ? applyVector(node.stored, line.direction) : line.direction;
    const turns = circularTurns(
      count(c.count),
      values.number(c.angle, ANGLE),
      values.literal(c.symmetric, FLAG) === true,
    );
    return turns.map(({ i, degrees }) => {
      const rotation = qaxis(direction, (degrees * Math.PI) / 180);
      const turned = applyVector({ position: [0, 0, 0], rotation }, point);
      return { i, j: 0, t: { position: [point[0] - turned[0], point[1] - turned[1], point[2] - turned[2]], rotation } };
    });
  }
  throw new FeaturePause('a path pattern of instances is not built yet');
}

/** The mirror plane of an assembly mirror, in the assembly: a default plane or a planar face. */
function mirrorPlane(
  ev: Evaluation,
  ref: Json,
  nodeOf: (v: unknown) => Node | null,
  whereOf: (node: Node | null) => Where,
): Plane {
  if ('standard' in ref) {
    const frame = STANDARD[(ref.standard as Json).name as string];
    if (!frame) throw new FeaturePause('the mirror plane is not a plane');
    return { point: frame.origin, normal: frame.normal };
  }
  const node = nodeOf(ref);
  const face = entityOf(whereOf(node), ref, 'the mirror plane');
  const surface = face.kind === 'face' ? ev.adapter.faceGeometry(face.key).surface : undefined;
  if (surface?.kind !== 'plane') throw new FeaturePause('the mirror plane is not a planar face');
  const point = surface.point as V3;
  const normal = surface.normal as V3;
  return node ? { point: apply(node.stored, point), normal: applyVector(node.stored, normal) } : { point, normal };
}

/** Builds every assembly of the document (chapter 10, step 3). */
export function evaluateAssemblies(ev: Evaluation, doc: Json): void {
  for (const asm of (doc.assemblies as Json[]) ?? []) {
    try {
      ensureAssembly(ev, asm.id as string);
    } catch (e) {
      const message = pauseMessage(e);
      if (message === undefined) throw e;
      ev.pauses.push({ feature: asm.id as string, message });
    }
  }
}

registerAssemblyBuilder(buildAssembly);
