/**
 * The joint solve of an assembly (12.2). Instances are rigid bodies; rigid
 * groups make one body of several instances; an assembly copy follows its
 * seed by its feature's transform. Each joint ties a frame on one body to a
 * frame on another, moved by its degrees of freedom.
 *
 * The solve starts from the stored placements and joint states. Bodies are
 * placed outward from the grounded ones along a spanning tree of the joints,
 * each joint at its starting state, so a chain or tree of joints is placed
 * exactly and moves nothing it does not have to. A body joined to nothing
 * grounded keeps the first instance of its group where it is stored. The
 * joints left over close loops: their mismatch, with every relation's, is
 * driven to zero by Gauss–Newton steps of least norm in the joint states, so
 * an under-constrained mechanism moves as little as it can from where it
 * was. Limits clamp each step. A loop that does not close pauses its joints.
 */
import { compose, difference, inverse, qaxis, qmul, type Quat, type Rigid } from './rigid';

/** A frame on a node, as a placement in that node's own coordinates; `node` null is the assembly itself. */
export interface JointEnd {
  node: number | null;
  frame: Rigid;
}

/** A node: an instance on a body, or a copy following another node. */
export type SolveNode =
  { body: number; offset: Rigid } | { seed: number; follow: (seed: Rigid) => Rigid; unfollow: (copy: Rigid) => Rigid };

export interface SolveBody {
  stored: Rigid;
  grounded: boolean;
}

export interface SolveJoint {
  id: string;
  /** The joint kind's degrees of freedom, in its order (12.1). */
  dofs: readonly string[];
  a: JointEnd;
  b: JointEnd;
  start: number[];
  limits: ([number, number] | null)[];
}

/** `value(joint b, dof b) = ratio × value(joint a, dof a)`. */
export interface SolveRelation {
  id: string;
  a: { joint: number; dof: number };
  b: { joint: number; dof: number };
  ratio: number;
}

export interface SolveInput {
  bodies: SolveBody[];
  nodes: SolveNode[];
  joints: SolveJoint[];
  relations: SolveRelation[];
}

export interface SolveOutput {
  /** Each node's placement. */
  placements: Rigid[];
  /** Each joint's solved values, in its kind's order. */
  values: number[][];
  /** Joints and relations the solve could not satisfy. */
  unsatisfied: string[];
}

const DEG = Math.PI / 180;
/** Residual below which a joint holds: mm, and radians. */
const TOLERANCE = 1e-9;
const ITERATIONS = 100;
const STEP = 1e-7;

/** A joint's motion (12.1): translations along the frame's axes, then turns about the moved axes, z, then y, then x. */
export function jointMotion(dofs: readonly string[], q: readonly number[]): Rigid {
  const value = (name: string) => {
    const i = dofs.indexOf(name);
    return i < 0 ? 0 : (q[i] as number);
  };
  const turn = (axis: [number, number, number], name: string): Quat => qaxis(axis, value(name) * DEG);
  const rotation = qmul(qmul(turn([0, 0, 1], 'rz'), turn([0, 1, 0], 'ry')), turn([1, 0, 0], 'rx'));
  return { position: [value('tx'), value('ty'), value('tz')], rotation };
}

const clamp = (v: number, limit: [number, number] | null) => (limit ? Math.min(Math.max(v, limit[0]), limit[1]) : v);

/** Solves `m · x = b` for a small symmetric positive definite `m`, by Gaussian elimination with pivoting. */
function linearSolve(m: number[][], b: number[]): number[] {
  const n = b.length;
  const a = m.map((row, i) => [...row, b[i] as number]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs((a[r] as number[])[c] as number) > Math.abs((a[pivot] as number[])[c] as number)) pivot = r;
    [a[c], a[pivot]] = [a[pivot] as number[], a[c] as number[]];
    const p = (a[c] as number[])[c] as number;
    if (Math.abs(p) < 1e-300) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = ((a[r] as number[])[c] as number) / p;
      if (f === 0) continue;
      for (let k = c; k <= n; k++)
        (a[r] as number[])[k] = ((a[r] as number[])[k] as number) - f * ((a[c] as number[])[k] as number);
    }
  }
  return a.map((row, i) => {
    const p = row[i] as number;
    return Math.abs(p) < 1e-300 ? 0 : (row[n] as number) / p;
  });
}

export function solvePose(input: SolveInput): SolveOutput {
  const { bodies, nodes, joints, relations } = input;

  // The body each node rides on.
  const bodyOf = (n: number): number => {
    const node = nodes[n] as SolveNode;
    return 'body' in node ? node.body : bodyOf(node.seed);
  };
  const nodePose = (n: number, poses: readonly Rigid[]): Rigid => {
    const node = nodes[n] as SolveNode;
    return 'body' in node ? compose(poses[node.body] as Rigid, node.offset) : node.follow(nodePose(node.seed, poses));
  };
  const bodyFromNode = (n: number, pose: Rigid): Rigid => {
    const node = nodes[n] as SolveNode;
    return 'body' in node ? compose(pose, inverse(node.offset)) : bodyFromNode(node.seed, node.unfollow(pose));
  };
  const endBody = (e: JointEnd) => (e.node === null ? -1 : bodyOf(e.node));

  // The spanning tree: from grounded bodies, then from the first body of each group joined to nothing grounded.
  const known = new Set<number>([-1]);
  const order: { joint: number; from: 'a' | 'b' }[] = [];
  const used = new Set<number>();
  const grow = () => {
    let progress = true;
    while (progress) {
      progress = false;
      joints.forEach((j, i) => {
        if (used.has(i)) return;
        const [a, b] = [endBody(j.a), endBody(j.b)];
        if (known.has(a) && !known.has(b)) order.push({ joint: i, from: 'a' });
        else if (known.has(b) && !known.has(a)) order.push({ joint: i, from: 'b' });
        else return;
        used.add(i);
        known.add(known.has(a) ? b : a);
        progress = true;
      });
    }
  };
  bodies.forEach((b, i) => {
    if (b.grounded) known.add(i);
  });
  grow();
  bodies.forEach((_, i) => {
    if (known.has(i)) return;
    known.add(i);
    grow();
  });
  const closing = joints.map((_, i) => i).filter((i) => !used.has(i));

  const place = (q: readonly number[][]): Rigid[] => {
    const poses = bodies.map((b) => b.stored);
    for (const { joint, from } of order) {
      const j = joints[joint] as SolveJoint;
      const motion = jointMotion(j.dofs, q[joint] as number[]);
      const at = (e: JointEnd) => (e.node === null ? e.frame : compose(nodePose(e.node, poses), e.frame));
      if (from === 'a') {
        const b = compose(compose(at(j.a), motion), inverse(j.b.frame));
        poses[bodyOf(j.b.node as number)] = bodyFromNode(j.b.node as number, b);
      } else {
        const a = compose(compose(at(j.b), inverse(motion)), inverse(j.a.frame));
        poses[bodyOf(j.a.node as number)] = bodyFromNode(j.a.node as number, a);
      }
    }
    return poses;
  };

  const residuals = (q: readonly number[][]): { r: number[]; owners: string[] } => {
    const poses = place(q);
    const at = (e: JointEnd) => (e.node === null ? e.frame : compose(nodePose(e.node, poses), e.frame));
    const r: number[] = [];
    const owners: string[] = [];
    for (const i of closing) {
      const j = joints[i] as SolveJoint;
      const d = difference(at(j.b), compose(at(j.a), jointMotion(j.dofs, q[i] as number[])));
      r.push(...d);
      owners.push(...d.map(() => j.id));
    }
    for (const rel of relations) {
      const a = (q[rel.a.joint] as number[])[rel.a.dof] as number;
      const b = (q[rel.b.joint] as number[])[rel.b.dof] as number;
      r.push((b - rel.ratio * a) * DEG);
      owners.push(rel.id);
    }
    return { r, owners };
  };

  // Starting values within limits, each relation's driven joint set from its driver.
  const q = joints.map((j) => j.start.map((v, k) => clamp(v, j.limits[k] ?? null)));
  for (const rel of relations) {
    const row = q[rel.b.joint] as number[];
    row[rel.b.dof] = clamp(
      rel.ratio * ((q[rel.a.joint] as number[])[rel.a.dof] as number),
      (joints[rel.b.joint] as SolveJoint).limits[rel.b.dof] ?? null,
    );
  }

  const initial = q.map((row) => [...row]);
  const vars: { joint: number; dof: number }[] = joints.flatMap((j, joint) => j.dofs.map((_, dof) => ({ joint, dof })));
  const norm = (r: readonly number[]) => Math.max(0, ...r.map(Math.abs));
  let current = residuals(q);
  for (let iteration = 0; iteration < ITERATIONS && norm(current.r) > TOLERANCE && vars.length > 0; iteration++) {
    // The Jacobian by forward differences in each joint value.
    const columns = vars.map(({ joint, dof }) => {
      const row = q[joint] as number[];
      const saved = row[dof] as number;
      row[dof] = saved + STEP;
      const moved = residuals(q).r;
      row[dof] = saved;
      return moved.map((v, i) => (v - (current.r[i] as number)) / STEP);
    });
    const m = current.r.length;
    const jjt = Array.from({ length: m }, (_, a) =>
      Array.from(
        { length: m },
        (_, b) =>
          columns.reduce((sum, col) => sum + (col[a] as number) * (col[b] as number), 0) + (a === b ? 1e-12 : 0),
      ),
    );
    const y = linearSolve(
      jjt,
      current.r.map((v) => -v),
    );
    const delta = columns.map((col) => col.reduce((sum, c, i) => sum + c * (y[i] as number), 0));
    // Halve the step until the mismatch shrinks.
    let factor = 1;
    let accepted = false;
    const start = q.map((row) => [...row]);
    for (let tries = 0; tries < 30 && !accepted; tries++, factor /= 2) {
      vars.forEach(({ joint, dof }, k) => {
        const row = q[joint] as number[];
        row[dof] = clamp(
          ((start[joint] as number[])[dof] as number) + factor * (delta[k] as number),
          (joints[joint] as SolveJoint).limits[dof] ?? null,
        );
      });
      const next = residuals(q);
      if (norm(next.r) < norm(current.r)) {
        current = next;
        accepted = true;
      }
    }
    if (!accepted) {
      q.forEach((row, i) => row.splice(0, row.length, ...(start[i] as number[])));
      break;
    }
  }

  const unsatisfied = [
    ...new Set(current.r.flatMap((v, i) => (Math.abs(v) > TOLERANCE ? [current.owners[i] as string] : []))),
  ];
  // A loop that does not close leaves every joint where the solve started.
  const values = unsatisfied.length > 0 ? initial : q;
  const poses = place(values);
  return { placements: nodes.map((_, n) => nodePose(n, poses)), values, unsatisfied };
}
