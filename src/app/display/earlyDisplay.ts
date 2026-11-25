/**
 * A display of the parts a build has finished so far (`Progress` phase
 * `built`), to show while the rest of a just-opened document builds. Each
 * part's bodies show as built; in an assembly, each instance of a built part
 * stands where the document stores it (its last solved placement), nested
 * assemblies composed. It holds no keys or entities, so nothing in it can be
 * picked, and an instance whose part builds a variant of its own (it carries
 * overrides) or comes from the library waits for the full display.
 */
import type {
  AssemblyDisplay,
  DefinitionDisplay,
  Display,
  EarlyBody,
  InstanceDisplay,
  Placement,
  Quat,
  Vec3,
} from '@tweakcad/worker/src/v2/service/types';
import { DEFAULT_BODY_COLOR } from '../viewport/style';

type Json = Record<string, unknown>;

/** The parts built so far, in the order they were. */
export interface EarlyParts {
  parts: readonly { part: string; bodies: readonly EarlyBody[] }[];
}

const IDENTITY: Placement = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // v + 2w(q×v) + 2q×(q×v)
  const cx = y * v[2] - z * v[1];
  const cy = z * v[0] - x * v[2];
  const cz = x * v[1] - y * v[0];
  return [
    v[0] + 2 * (w * cx + y * cz - z * cy),
    v[1] + 2 * (w * cy + z * cx - x * cz),
    v[2] + 2 * (w * cz + x * cy - y * cx),
  ];
}

/** `child` placed within `parent`. */
export function compose(parent: Placement, child: Placement): Placement {
  const p = rotate(parent.rotation, child.position);
  return {
    position: [parent.position[0] + p[0], parent.position[1] + p[1], parent.position[2] + p[2]],
    rotation: multiply(parent.rotation, child.rotation),
  };
}

function placementOf(v: unknown): Placement {
  const p = v as Partial<Placement> | undefined;
  return Array.isArray(p?.position) && Array.isArray(p?.rotation) && p.position.length === 3 && p.rotation.length === 4
    ? { position: p.position as Vec3, rotation: p.rotation as Quat }
    : IDENTITY;
}

/** Whether a flag value is literally true; one worked out by an expression shows. */
function literallyTrue(v: unknown): boolean {
  const text = ((v as Json | undefined)?.def as Json | undefined)?.expr as Json | undefined;
  return typeof text?.text === 'string' && text.text.trim() === 'true';
}

function definitionOf(index: number, part: string, bodies: readonly EarlyBody[]): DefinitionDisplay {
  return {
    index,
    part,
    variant: '',
    rollback: null,
    bodies: bodies.map((b, i) => ({
      key: 0,
      id: `early:${part}:${i}`,
      feature: '',
      name: `Body ${i + 1}`,
      color: DEFAULT_BODY_COLOR,
      opacity: 1,
      visible: true,
      faceStyles: [],
      mesh: {
        positions: b.positions,
        normals: b.normals,
        indices: b.indices,
        faces: new Uint32Array(0),
        segments: b.segments,
        edges: new Uint32Array(0),
        points: new Float32Array(0),
        vertices: new Uint32Array(0),
      },
    })),
    sketches: [],
    construction: [],
    threads: [],
  };
}

/** The display of `early`, the built parts of `doc` so far. */
export function earlyDisplay(early: EarlyParts, doc: Json): Display {
  const definitions = early.parts.map((p, i) => definitionOf(i, p.part, p.bodies));
  const parts: Record<string, number> = {};
  definitions.forEach((d) => (parts[d.part] = d.index));
  const assemblies = new Map(((doc.assemblies as Json[] | undefined) ?? []).map((a) => [String(a.id), a]));

  const instancesOf = (assembly: Json, at: Placement, path: string[], seen: Set<string>): InstanceDisplay[] =>
    ((assembly.instances as Json[] | undefined) ?? []).flatMap((inst) => {
      if (literallyTrue(inst.suppressed) || ((inst.overrides as unknown[] | undefined) ?? []).length > 0) return [];
      const of = inst.of as Json | undefined;
      const placed = compose(at, placementOf(inst.placement));
      const here = [...path, String(inst.id)];
      const part = (of?.part as Json | undefined)?.id;
      if (typeof part === 'string') {
        const definition = parts[part];
        return definition === undefined
          ? []
          : [{ path: here, definition, placement: placed, override: {}, visible: true }];
      }
      const sub = (of?.assembly as Json | undefined)?.id;
      const row = typeof sub === 'string' ? assemblies.get(sub) : undefined;
      if (!row || seen.has(String(sub))) return [];
      return instancesOf(row, placed, here, new Set([...seen, String(sub)]));
    });

  const shown: AssemblyDisplay[] = [...assemblies.values()].map((a) => ({
    id: String(a.id),
    instances: instancesOf(a, IDENTITY, [], new Set([String(a.id)])),
    joints: {},
    jointFrames: {},
    activePosition: null,
    exploded: {},
  }));
  return {
    generation: -1,
    definitions,
    parts,
    assemblies: shown,
    entities: [],
    pauses: [],
    stale: [],
    outOfDate: [],
    timing: { evaluate: 0, display: 0, resumed: 0 },
  };
}
