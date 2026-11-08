/**
 * Assemblies on the real kernel (chapter 12): instances of parts placed by a
 * revolute joint, a pose change, insertion overrides building variants, and
 * picks through instance paths that survive an edit to the part.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { indexItem, readDocument, resolve, writeRecord, type EntityRecord, type NamedEntity } from '@tweakcad/format';
import { Docs, instancePath, pathOf } from './assemblyDocs';
import { evaluateDocument, type AssemblyResult, type Evaluation } from './evaluate';
import type { Json, V3 } from './context';
import { applyVector, type Rigid } from './rigid';
import { instanceStep, variantsOf } from './variants';

let k: OcctKernel;
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

function evaluate(doc: Json): Evaluation {
  const read = readDocument(doc);
  expect(read.diagnostics.filter((d) => d.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  return ev;
}

const close = (a: readonly number[], b: readonly number[], tol = 1e-6) =>
  a.every((v, i) => Math.abs(v - (b[i] as number)) <= tol);

function one(ev: Evaluation, asm: AssemblyResult, ref: Json): NamedEntity {
  const found = resolve(ref.entity as EntityRecord, asm.state, ev.adapter);
  if (found.outcome !== 'same' || found.entities.length !== 1)
    throw new Error(`expected one entity, got ${found.outcome}`);
  return found.entities[0] as NamedEntity;
}

function measures(ev: Evaluation, e: NamedEntity): { normal: V3; centroid: V3; volume: number } {
  return ev.adapter.measures(e.key) as unknown as { normal: V3; centroid: V3; volume: number };
}

/** An attribute of the assembly that locks `joint` (16.1). */
const lockOn = (d: Docs, joint: string): Json => ({
  id: d.id('attr'),
  target: { object: { joint: { id: joint } } },
  properties: { locked: { id: d.id('val'), def: { expr: { text: 'true', grammar: 1, refs: {} } } } },
});

interface Hinge {
  doc: Json;
  asm: string;
  base: string;
  arm: string;
  armBox: string;
  joint: string;
  d: Docs;
}

/**
 * A 40 × 40 × 10 base, grounded, and a 30 mm arm of height `armHeight`
 * hinged on the base's top face by a revolute joint at state `angle`. The
 * arm's stored placement is somewhere else: the joint places it.
 */
function hinge(o: { angle?: number; armHeight?: number; limits?: [string, string]; spare?: boolean } = {}): Hinge {
  const d = new Docs();
  const base = d.part('Base');
  const baseBox = base.box('40 mm', '40 mm', '10 mm');
  const arm = d.part('Arm');
  const height = arm.parameter('height', `${o.armHeight ?? 4} mm`);
  const armBox = arm.box('30 mm', '6 mm', height, [15, 0, 0]);
  const a = d.assembly('Hinge');
  const baseInst = a.instance({ part: { id: base.id } }, { grounded: true });
  const armInst = a.instance({ part: { id: arm.id } }, { at: [100, 50, -20], turnZ: 33 });
  const top = a.origin(d.planeFrame(d.faceThrough(baseInst, baseBox, '+z')));
  const bottom = a.origin(d.planeFrame(d.faceThrough(armInst, armBox, '-z'), { flip: true }));
  const joint = a.joint('revolute', top, bottom, {
    state: { rz: o.angle ?? 0 },
    ...(o.limits ? { limits: { rz: o.limits } } : {}),
  });
  // A spare arm of the same build, lying where its stored placement puts it.
  if (o.spare) a.instance({ part: { id: arm.id } }, { at: [0, 0, 0] });
  return { doc: d.document({ assembly: { id: a.id } }), asm: a.id, base: baseInst, arm: armInst, armBox, joint, d };
}

describe('a two-part assembly with a revolute joint', () => {
  it('places the arm on the base by the joint, whatever its stored placement', () => {
    const h = hinge();
    const ev = evaluate(h.doc);
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(h.asm) as AssemblyResult;
    const arm = asm.nodes.find((n) => n.instance === h.arm) as AssemblyResult['nodes'][number];
    expect(close(arm.placement.position, [0, 0, 7])).toBe(true);
    expect(close(applyVector(arm.placement, [1, 0, 0]), [1, 0, 0])).toBe(true);
    expect(asm.joints.get(h.joint)).toEqual({ rz: 0 });
    const end = measures(ev, one(ev, asm, h.d.faceThrough(h.arm, h.armBox, '+x')));
    expect(close(end.normal, [1, 0, 0])).toBe(true);
    expect(close(end.centroid, [30, 0, 7])).toBe(true);
  });

  it('turns the arm with the joint state: a pose change', () => {
    const h = hinge({ angle: 90 });
    const ev = evaluate(h.doc);
    const asm = ev.assemblies.get(h.asm) as AssemblyResult;
    const end = measures(ev, one(ev, asm, h.d.faceThrough(h.arm, h.armBox, '+x')));
    expect(close(end.normal, [0, 1, 0])).toBe(true);
    expect(close(end.centroid, [0, 30, 7])).toBe(true);
    expect(asm.joints.get(h.joint)).toEqual({ rz: 90 });
  });

  it('holds the joint within its limits', () => {
    const h = hinge({ angle: 120, limits: ['-45 deg', '45 deg'] });
    const ev = evaluate(h.doc);
    const asm = ev.assemblies.get(h.asm) as AssemblyResult;
    expect(asm.joints.get(h.joint)?.rz).toBe(45);
    const end = measures(ev, one(ev, asm, h.d.faceThrough(h.arm, h.armBox, '+x')));
    expect(close(end.normal, [Math.SQRT1_2, Math.SQRT1_2, 0])).toBe(true);
  });

  it('uses the active position in place of the joint state', () => {
    const h = hinge({ angle: 0 });
    const asmJson = (h.doc.assemblies as Json[])[0] as Json;
    const pos = h.d.id('pos');
    asmJson.positions = [{ id: pos, name: 'Open', state: { [h.joint]: { rz: -90 } } }];
    asmJson.activePosition = { position: { id: pos } };
    const ev = evaluate(h.doc);
    const asm = ev.assemblies.get(h.asm) as AssemblyResult;
    expect(asm.activePosition).toBe(pos);
    expect(asm.joints.get(h.joint)).toEqual({ rz: -90 });
    expect(close(measures(ev, one(ev, asm, h.d.faceThrough(h.arm, h.armBox, '+x'))).normal, [0, -1, 0])).toBe(true);
  });

  it('holds a locked joint at its state, whatever position is active', () => {
    const h = hinge({ angle: 30 });
    const asmJson = (h.doc.assemblies as Json[])[0] as Json;
    const pos = h.d.id('pos');
    asmJson.positions = [{ id: pos, name: 'Open', state: { [h.joint]: { rz: -90 } } }];
    asmJson.activePosition = { position: { id: pos } };
    asmJson.attributes = [lockOn(h.d, h.joint)];
    const ev = evaluate(h.doc);
    const asm = ev.assemblies.get(h.asm) as AssemblyResult;
    expect(ev.pauses).toEqual([]);
    expect(asm.joints.get(h.joint)).toEqual({ rz: 30 });
  });

  it('keeps a pick on a face of an instance through an edit to its part, a pose change and a second instance', () => {
    const before = hinge({ angle: 30 });
    const ev = evaluate(before.doc);
    const asm = ev.assemblies.get(before.asm) as AssemblyResult;
    const picked = one(ev, asm, before.d.faceThrough(before.arm, before.armBox, '+y'));
    const record = writeRecord(picked, asm.state, ev.adapter);
    // A taller arm (the face grows and the joint lifts the arm), a turned joint, a spare arm sharing the build.
    for (const edit of [{ armHeight: 9 }, { angle: 75 }, { spare: true }]) {
      const after = hinge({ angle: 30, ...edit });
      const ev2 = evaluate(after.doc);
      const asm2 = ev2.assemblies.get(after.asm) as AssemblyResult;
      const found = resolve(record, asm2.state, ev2.adapter);
      expect(found.outcome).toBe('same');
      const face = measures(ev2, (found as { entities: NamedEntity[] }).entities[0] as NamedEntity);
      const turn = (((edit.angle ?? 30) as number) * Math.PI) / 180;
      const [c, sn] = [Math.cos(turn), Math.sin(turn)];
      const half = (edit.armHeight ?? 4) / 2;
      expect(close(face.normal, [-sn, c, 0])).toBe(true);
      // Its centre: 15 mm out along the arm, 3 mm to its side, half its height above the base.
      expect(close(face.centroid, [15 * c - 3 * sn, 15 * sn + 3 * c, 5 + half])).toBe(true);
    }
  });
});

describe('insertion overrides', () => {
  function plates() {
    const d = new Docs();
    const p = d.part('Plate');
    const width = p.parameter('width', '10 mm');
    const hidden = p.parameter('hidden', '10 mm', false);
    const box = p.box(width, '10 mm', hidden);
    const a = d.assembly('Plates');
    const plain = a.instance({ part: { id: p.id } }, { grounded: true });
    const wide = a.instance(
      { part: { id: p.id } },
      { at: [50, 0, 0], grounded: true, overrides: [d.override(width, '20 mm')] },
    );
    const same = a.instance(
      { part: { id: p.id } },
      { at: [100, 0, 0], grounded: true, overrides: [d.override(width, '2 * 10 mm')] },
    );
    return { d, a, p, box, plain, wide, same, hidden, width };
  }

  it('builds a second variant for a distinct override set, shared by equal ones', () => {
    const t = plates();
    const ev = evaluate(t.d.document({ assembly: { id: t.a.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(t.a.id) as AssemblyResult;
    const node = (inst: string) => asm.nodes.find((n) => n.instance === inst) as AssemblyResult['nodes'][number];
    expect(node(t.plain).variant.ev).toBe(ev);
    expect(node(t.wide).variant).toBe(node(t.same).variant);
    expect(node(t.wide).variant).not.toBe(node(t.plain).variant);
    expect(variantsOf(ev)).toHaveLength(1);
    const body = (inst: string) =>
      measures(ev, one(ev, asm, t.d.ref('body', t.box, 'body', [instanceStep(inst)], [indexItem(0) as Json]))).volume;
    expect(body(t.plain)).toBeCloseTo(1000, 6);
    expect(body(t.wide)).toBeCloseTo(2000, 6);
    expect(body(t.same)).toBeCloseTo(2000, 6);
    // The part itself still builds as written.
    expect(ev.parts.get(t.p.id)?.state.bodies.size).toBe(1);
  });

  it('reports a feature that pauses in a variant on the host, through its instance, once per build', () => {
    const t = plates();
    // Both overriding instances share one build, in which a zero width pauses the box.
    for (const i of [1, 2]) ((t.a.json.instances as Json[])[i] as Json).overrides = [t.d.override(t.width, '0 mm')];
    const ev = evaluate(t.d.document({ assembly: { id: t.a.id } }));
    expect(ev.pauses).toEqual([{ feature: t.box, message: expect.any(String), through: [t.wide] }]);
  });

  it('pauses an instance that overrides a parameter that is not public', () => {
    const t = plates();
    ((t.a.json.instances as Json[])[1] as Json).overrides = [t.d.override(t.hidden, '3 mm')];
    const ev = evaluate(t.d.document({ assembly: { id: t.a.id } }));
    expect(ev.pauses).toEqual([{ feature: t.wide, message: expect.stringContaining('not public') }]);
    expect((ev.assemblies.get(t.a.id) as AssemblyResult).nodes.map((n) => n.instance)).toEqual([t.plain, t.same]);
  });

  it('builds a library component with its public parameter overridden', () => {
    const lib = new Docs(7);
    const part = lib.part('Spacer');
    const width = part.parameter('width', '10 mm');
    const box = part.box(width, '10 mm', '10 mm');
    const component = lib.document({ part: { id: part.id } });

    const d = new Docs();
    const entry = d.embed(component);
    const a = d.assembly('Stack');
    const plain = a.instance({ component: { value: d.val('c', { c: entry }) } }, { grounded: true });
    const wide = a.instance(
      { component: { value: d.val('c', { c: entry }) } },
      { grounded: true, at: [0, 0, 20], overrides: [d.override(width, '30 mm')] },
    );
    const ev = evaluate(d.document({ assembly: { id: a.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(a.id) as AssemblyResult;
    const body = (inst: string) =>
      measures(ev, one(ev, asm, d.ref('body', box, 'body', [instanceStep(inst)], [indexItem(0) as Json]))).volume;
    expect(body(plain)).toBeCloseTo(1000, 6);
    expect(body(wide)).toBeCloseTo(3000, 6);
    expect(variantsOf(ev)).toHaveLength(2);
  });
});

describe('relations, loops and pauses', () => {
  it('drives a second joint by a gear relation', () => {
    const d = new Docs();
    const base = d.part('Base');
    const baseBox = base.box('100 mm', '40 mm', '10 mm');
    const gear = d.part('Gear');
    const gearBox = gear.box('20 mm', '4 mm', '4 mm', [10, 0, 0]);
    const a = d.assembly('Gears');
    const b = a.instance({ part: { id: base.id } }, { grounded: true });
    const g1 = a.instance({ part: { id: gear.id } });
    const g2 = a.instance({ part: { id: gear.id } });
    const left = a.origin(d.planeFrame(d.faceThrough(b, baseBox, '+z'), { at: [-20, 0, 0] }));
    const right = a.origin(d.planeFrame(d.faceThrough(b, baseBox, '+z'), { at: [20, 0, 0] }));
    const j1 = a.joint(
      'revolute',
      left,
      { frame: d.planeFrame(d.faceThrough(g1, gearBox, '-z'), { flip: true }) },
      { state: { rz: 30 } },
    );
    const j2 = a.joint(
      'revolute',
      right,
      { frame: d.planeFrame(d.faceThrough(g2, gearBox, '-z'), { flip: true }) },
      { state: { rz: 5 } },
    );
    a.relation('gear', [j1, j2], '-2');
    const ev = evaluate(d.document({ assembly: { id: a.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(a.id) as AssemblyResult;
    expect(asm.joints.get(j1)?.rz).toBeCloseTo(30, 9);
    expect(asm.joints.get(j2)?.rz).toBeCloseTo(-60, 9);
    const n = measures(ev, one(ev, asm, d.faceThrough(g2, gearBox, '+x'))).normal;
    expect(close(n, [Math.cos(-Math.PI / 3), Math.sin(-Math.PI / 3), 0])).toBe(true);

    // With the driven gear locked, the driving one turns to meet it instead.
    const locked = d.document({ assembly: { id: a.id } });
    ((locked.assemblies as Json[])[0] as Json).attributes = [lockOn(d, j2)];
    const ev3 = evaluate(locked);
    expect(ev3.pauses).toEqual([]);
    const held = ev3.assemblies.get(a.id) as AssemblyResult;
    expect(held.joints.get(j2)?.rz).toBeCloseTo(5, 9);
    expect(held.joints.get(j1)?.rz).toBeCloseTo(-2.5, 6);

    // A rack and pinion needs a joint that slides: two hinges are the wrong kind, and the relation pauses.
    const rack = a.relation('rackPinion', [j1, j2], '0.1 [mm/deg]');
    const ev2 = evaluate(d.document({ assembly: { id: a.id } }));
    expect(ev2.pauses).toEqual([{ feature: rack, message: expect.stringContaining('wrong kind') }]);
  });

  it('closes a loop of two hinges on one axis, and pauses one that cannot close', () => {
    const d = new Docs();
    const base = d.part('Base');
    const baseBox = base.box('40 mm', '40 mm', '10 mm');
    const lid = d.part('Lid');
    const lidBox = lid.box('40 mm', '40 mm', '2 mm');
    const a = d.assembly('Box');
    const b = a.instance({ part: { id: base.id } }, { grounded: true });
    const l = a.instance({ part: { id: lid.id } });
    const top = d.faceThrough(b, baseBox, '+z');
    const under = d.faceThrough(l, lidBox, '-z');
    a.joint(
      'revolute',
      { frame: d.planeFrame(top) },
      { frame: d.planeFrame(under, { flip: true }) },
      { state: { rz: 10 } },
    );
    // A second joint on the same axis, at another angle: the loop closes by moving both as little as it can.
    const first = ((a.json.joints as Json[])[0] as Json).id as string;
    const second = a.joint(
      'cylindrical',
      { frame: d.planeFrame(top) },
      { frame: d.planeFrame(under, { flip: true }) },
      { state: { rz: 0, tz: 3 } },
    );
    const ev = evaluate(d.document({ assembly: { id: a.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(a.id) as AssemblyResult;
    expect(asm.joints.get(first)?.rz).toBeCloseTo(5, 6);
    expect(asm.joints.get(second)?.rz).toBeCloseTo(5, 6);
    expect(asm.joints.get(second)?.tz).toBeCloseTo(0, 6);

    // A slider held at 5 mm cannot close against the hinge.
    const rows = (a.json.joints as Json[])[1] as Json;
    rows.kind = 'slider';
    rows.state = { tz: 5 };
    rows.limits = { tz: { between: { min: d.val('5 mm'), max: d.val('5 mm') } } };
    const ev2 = evaluate(d.document({ assembly: { id: a.id } }));
    expect(ev2.pauses).toEqual([{ feature: second, message: expect.stringContaining('cannot all hold') }]);
  });

  it('pauses a joint whose frame is attached to two instances', () => {
    const h = hinge();
    const asmJson = (h.doc.assemblies as Json[])[0] as Json;
    const origin = (asmJson.jointOrigins as Json[])[1] as Json;
    const attach = (origin.frame as Json).attach as Json;
    attach.mode = h.d.val('"planeAtPoint"');
    (attach.support as Json[]).push(
      h.d.faceThrough(h.base, ((h.doc.parts as Json[])[0] as { timeline: Json[] }).timeline[0]?.id as string, '+z'),
    );
    h.doc.names = h.d.names.toJson();
    const ev = evaluate(h.doc);
    expect(ev.pauses).toContainEqual({ feature: origin.id, message: expect.stringContaining('several instances') });
    expect(ev.pauses).toContainEqual({ feature: h.joint, message: 'the joint origin did not build' });
  });
});

describe('joint kinds with several freedoms, and the screw relation', () => {
  /** The hinge's base and arm joined by a joint of `kind` at `state`, the arm's end face measured. */
  function joined(kind: string, state: Record<string, number>, screw?: string) {
    const d = new Docs();
    const base = d.part('Base');
    const baseBox = base.box('40 mm', '40 mm', '10 mm');
    const arm = d.part('Arm');
    const armBox = arm.box('30 mm', '6 mm', '4 mm', [15, 0, 0]);
    const a = d.assembly('Joined');
    const b = a.instance({ part: { id: base.id } }, { grounded: true });
    const m = a.instance({ part: { id: arm.id } }, { at: [100, 50, -20], turnZ: 33 });
    const top = a.origin(d.planeFrame(d.faceThrough(b, baseBox, '+z')));
    const bottom = a.origin(d.planeFrame(d.faceThrough(m, armBox, '-z'), { flip: true }));
    const joint = a.joint(kind, top, bottom, { state });
    if (screw) a.relation('screw', [joint], screw);
    const ev = evaluate(d.document({ assembly: { id: a.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(a.id) as AssemblyResult;
    return { end: measures(ev, one(ev, asm, d.faceThrough(m, armBox, '+x'))), state: asm.joints.get(joint) };
  }

  it('turns the arm about any axis through the ball', () => {
    const turned = joined('ball', { rx: 0, ry: 90, rz: 0 });
    expect(close(turned.end.normal, [0, 0, -1])).toBe(true);
    // The end's centre, 30 along and 2 above the joint in the arm, turned a quarter about y from the base's top at z 5.
    expect(turned.end.centroid.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([2, 0, -25]);
    const flat = joined('ball', { rx: 0, ry: 0, rz: 90 });
    expect(close(flat.end.normal, [0, 1, 0])).toBe(true);
    expect(close(flat.end.centroid, [0, 30, 7])).toBe(true);
  });

  it('slides the arm in the plane and turns it about the normal', () => {
    const r = joined('planar', { tx: 5, ty: -3, rz: 90 });
    expect(r.state).toEqual({ tx: 5, ty: -3, rz: 90 });
    expect(close(r.end.normal, [0, 1, 0])).toBe(true);
    expect(close(r.end.centroid, [5, 27, 7])).toBe(true);
  });

  it('slides the arm along the slot and turns it on the pin', () => {
    const r = joined('pinSlot', { tx: 4, rz: 90 });
    expect(close(r.end.normal, [0, 1, 0])).toBe(true);
    expect(close(r.end.centroid, [4, 30, 7])).toBe(true);
  });

  it('advances a cylindrical joint by the screw lead as it turns', () => {
    const r = joined('cylindrical', { rz: 90, tz: 0 }, '0.02 [mm/deg]');
    expect(r.state?.rz).toBeCloseTo(90, 9);
    expect(r.state?.tz).toBeCloseTo(1.8, 9);
    expect(close(r.end.centroid, [0, 30, 7 + 1.8])).toBe(true);
  });
});

describe('assembly features', () => {
  function row() {
    const d = new Docs();
    const p = d.part('Peg');
    const box = p.box('10 mm', '10 mm', '10 mm', [20, 0, 0]);
    const a = d.assembly('Row');
    const seed = a.instance({ part: { id: p.id } }, { grounded: true });
    return { d, p, box, a, seed };
  }
  const centroidOf = (ev: Evaluation, asm: AssemblyResult, ref: Json) => measures(ev, one(ev, asm, ref)).centroid;

  it('patterns an instance, and moves copies with their seed', () => {
    const t = row();
    const fid = t.a.feature('core.asm.pattern', {
      of: { set: [pathOf(instancePath(t.seed))] },
      layout: {
        linear: {
          directions: [
            {
              direction: { axis: { axis: t.d.val('"y"'), reversed: t.d.flag(false) } },
              count: t.d.val('3'),
              spacing: { equal: { s: t.d.val('15 mm') } },
            },
          ],
        },
      },
      skip: { set: [] },
    });
    const ev = evaluate(t.d.document({ assembly: { id: t.a.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(t.a.id) as AssemblyResult;
    expect(asm.nodes).toHaveLength(3);
    const slot = (i: number) => [instanceStep(t.seed), { op: { id: fid }, key: { slot: { i, j: 0 } } }];
    expect(close(centroidOf(ev, asm, t.d.ref('face', t.box, '+z', slot(2))), [20, 30, 5])).toBe(true);
    expect(asm.nodes[2]?.path).toEqual({
      path: [{ copy: { op: { id: fid }, key: { slot: { i: 2, j: 0 } } } }, { instance: { id: t.seed } }],
    });
  });

  it('patterns an instance round an axis, leaving out a skipped slot', () => {
    const t = row();
    const fid = t.a.feature('core.asm.pattern', {
      of: { set: [pathOf(instancePath(t.seed))] },
      layout: {
        circular: {
          axis: { along: { ref: { standard: { name: 'z' } }, reversed: t.d.flag(false) } },
          count: t.d.val('4'),
          angle: t.d.val('360 deg'),
          symmetric: t.d.flag(false),
        },
      },
      skip: { set: [{ slot: { i: 2, j: 0 } }] },
    });
    const ev = evaluate(t.d.document({ assembly: { id: t.a.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(t.a.id) as AssemblyResult;
    // The seed and slots 1 and 3; slot 2, half a turn round, is skipped.
    expect(asm.nodes).toHaveLength(3);
    const slot = (i: number) => [instanceStep(t.seed), { op: { id: fid }, key: { slot: { i, j: 0 } } }];
    expect(close(centroidOf(ev, asm, t.d.ref('face', t.box, '+z', slot(1))), [0, 20, 5])).toBe(true);
    expect(close(centroidOf(ev, asm, t.d.ref('face', t.box, '+z', slot(3))), [0, -20, 5])).toBe(true);
    expect(() => one(ev, asm, t.d.ref('face', t.box, '+z', slot(2)))).toThrow();
  });

  it('patterns an instance symmetrically, the other side at negative slots', () => {
    const t = row();
    const fid = t.a.feature('core.asm.pattern', {
      of: { set: [pathOf(instancePath(t.seed))] },
      layout: {
        linear: {
          directions: [
            {
              direction: { axis: { axis: t.d.val('"y"'), reversed: t.d.flag(false) } },
              count: t.d.val('3'),
              spacing: { equal: { s: t.d.val('15 mm') } },
              symmetric: t.d.flag(true),
            },
          ],
        },
      },
      skip: { set: [] },
    });
    const ev = evaluate(t.d.document({ assembly: { id: t.a.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(t.a.id) as AssemblyResult;
    expect(asm.nodes).toHaveLength(3);
    const slot = (i: number) => [instanceStep(t.seed), { op: { id: fid }, key: { slot: { i, j: 0 } } }];
    expect(close(centroidOf(ev, asm, t.d.ref('face', t.box, '+z', slot(1))), [20, 15, 5])).toBe(true);
    expect(close(centroidOf(ev, asm, t.d.ref('face', t.box, '+z', slot(-1))), [20, -15, 5])).toBe(true);

    const c = row();
    const cid = c.a.feature('core.asm.pattern', {
      of: { set: [pathOf(instancePath(c.seed))] },
      layout: {
        circular: {
          axis: { along: { ref: { standard: { name: 'z' } }, reversed: c.d.flag(false) } },
          count: c.d.val('3'),
          angle: c.d.val('180 deg'),
          symmetric: c.d.flag(true),
        },
      },
      skip: { set: [] },
    });
    const cev = evaluate(c.d.document({ assembly: { id: c.a.id } }));
    expect(cev.pauses).toEqual([]);
    const casm = cev.assemblies.get(c.a.id) as AssemblyResult;
    const cslot = (i: number) => [instanceStep(c.seed), { op: { id: cid }, key: { slot: { i, j: 0 } } }];
    expect(casm.nodes).toHaveLength(3);
    expect(close(centroidOf(cev, casm, c.d.ref('face', c.box, '+z', cslot(1))), [0, 20, 5])).toBe(true);
    expect(close(centroidOf(cev, casm, c.d.ref('face', c.box, '+z', cslot(-1))), [0, -20, 5])).toBe(true);
  });

  it('mirrors an instance: a turned copy of the same part, or an opposite-hand derived part', () => {
    const t = row();
    // An L of two boxes, so its mirror image differs from it.
    t.p.box('10 mm', '30 mm', '10 mm', [30, 10, 0], 'join');
    const seedRow = (t.a.json.instances as Json[])[0] as Json;
    seedRow.placement = { position: [0, 50, 0], rotation: [0, 0, 0, 1] };
    const mirrorPart = t.d.part('Peg mirrored');
    mirrorPart.derive({ part: { id: t.p.id } }, { mirror: 'yz' });
    t.a.feature('core.asm.mirror', {
      of: { set: [pathOf(instancePath(t.seed))] },
      plane: { standard: { name: 'xz' } },
      hand: { same: {} },
    });
    const boxOf = (ev: Evaluation, shape: string) =>
      ev.adapter.measures(ev.adapter.topology(shape).solids[0]?.solid as number).bbox as unknown as [V3, V3];
    const ev = evaluate(t.d.document({ assembly: { id: t.a.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(t.a.id) as AssemblyResult;
    // Same hand: the seed's own axis nearest the plane's normal is y, so the copy is the part reflected in it, then in xz: moved, not turned.
    const [lo, hi] = boxOf(ev, asm.nodes[0]?.shapes[0] as string);
    const [clo, chi] = boxOf(ev, asm.nodes[1]?.shapes[0] as string);
    expect(close(clo, [lo[0], lo[1] - 100, lo[2]])).toBe(true);
    expect(close(chi, [hi[0], hi[1] - 100, hi[2]])).toBe(true);

    // Opposite hand: the copy is an instance of the mirrored part, landing exactly on the mirror image.
    const feature = (t.a.json.timeline as Json[])[0] as Json;
    seedRow.placement = { position: [5, 10, 0], rotation: [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)] };
    feature.inputs = {
      of: { set: [pathOf(instancePath(t.seed))] },
      plane: { standard: { name: 'yz' } },
      hand: { opposite: { parts: [{ instance: pathOf(instancePath(t.seed)), part: { id: mirrorPart.id } }] } },
    };
    const ev2 = evaluate(t.d.document({ assembly: { id: t.a.id } }));
    expect(ev2.pauses).toEqual([]);
    const asm2 = ev2.assemblies.get(t.a.id) as AssemblyResult;
    const copy = asm2.nodes[1] as AssemblyResult['nodes'][number];
    expect(copy.variant.id).toBe(mirrorPart.id);
    const [slo, shi] = boxOf(ev2, asm2.nodes[0]?.shapes[0] as string);
    const [mlo, mhi] = boxOf(ev2, copy.shapes[0] as string);
    expect(close(mlo, [-shi[0], slo[1], slo[2]])).toBe(true);
    expect(close(mhi, [-slo[0], shi[1], shi[2]])).toBe(true);
  });

  it('replicates an instance at each target frame', () => {
    const t = row();
    t.a.feature('core.asm.replicate', {
      of: { set: [pathOf(instancePath(t.seed))] },
      seed: t.d.fixedFrame(),
      targets: [t.d.fixedFrame([0, 0, 50]), t.d.fixedFrame([0, 0, 0], 90)],
    });
    const ev = evaluate(t.d.document({ assembly: { id: t.a.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(t.a.id) as AssemblyResult;
    const placements = asm.nodes.map((n) => n.placement.position);
    expect(placements).toHaveLength(3);
    expect(close(placements[1] as V3, [0, 0, 50])).toBe(true);
    expect(close(applyVector(asm.nodes[2]?.placement as Rigid, [1, 0, 0]), [0, 1, 0])).toBe(true);
  });

  it('records exploded views as data', () => {
    const t = row();
    const other = t.a.instance({ part: { id: t.p.id } }, { grounded: true, at: [0, 40, 0] });
    const view = t.a.exploded('Apart', [
      { instances: [pathOf(instancePath(other))], at: [0, 0, 30] },
      { instances: [pathOf(instancePath(other))], at: [10, 0, 0] },
    ]);
    const ev = evaluate(t.d.document({ assembly: { id: t.a.id } }));
    const asm = ev.assemblies.get(t.a.id) as AssemblyResult;
    const moved = asm.exploded.get(view) as Map<string, Rigid>;
    expect(moved.size).toBe(1);
    expect(close([...moved.values()][0]?.position as V3, [10, 40, 30])).toBe(true);
  });
});

describe('nested assemblies and copies in the solve', () => {
  it('names entities through every instance of the path, and joins to geometry inside a sub-assembly', () => {
    const h = hinge({ angle: 90 });
    const d = h.d;
    const plate = d.part('Plate');
    const plateBox = plate.box('200 mm', '200 mm', '2 mm');
    const top = d.assembly('Top');
    const ground = top.instance({ part: { id: plate.id } }, { grounded: true });
    const fixed = top.instance({ assembly: { id: h.asm } }, { grounded: true, at: [100, 0, 0] });
    const loose = top.instance({ assembly: { id: h.asm } }, { at: [0, 0, -40], turnZ: 10 });
    const baseBox = ((h.doc.parts as Json[])[0] as { timeline: Json[] }).timeline[0]?.id as string;
    // The loose copy of the hinge stands on the plate by its base's bottom face, 50 mm out along y.
    const under = d.ref('face', baseBox, '-z', [instanceStep(h.base), instanceStep(loose)]);
    top.joint(
      'rigid',
      { frame: d.planeFrame(d.faceThrough(ground, plateBox, '+z'), { at: [0, 50, 0] }) },
      { frame: d.planeFrame(under, { flip: true }) },
    );
    const ev = evaluate(d.document({ assembly: { id: top.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(top.id) as AssemblyResult;
    const armEnd = (inst: string) =>
      measures(ev, one(ev, asm, d.ref('face', h.armBox, '+x', [instanceStep(h.arm), instanceStep(inst)])));
    expect(close(armEnd(fixed).normal, [0, 1, 0])).toBe(true);
    expect(close(armEnd(fixed).centroid, [100, 30, 7])).toBe(true);
    // The plate's top is at z 1; the base's bottom lands there, so the arm's end is at 1 + 5 + 7.
    expect(close(armEnd(loose).centroid, [0, 80, 13])).toBe(true);
    expect(asm.nodes.find((n) => n.instance === loose)?.path).toEqual({ path: [{ instance: { id: loose } }] });
  });

  it('lets a joint use a pattern copy, which its seed follows', () => {
    const d = new Docs();
    const base = d.part('Base');
    const baseBox = base.box('40 mm', '40 mm', '10 mm');
    const peg = d.part('Peg');
    const pegBox = peg.box('4 mm', '4 mm', '4 mm');
    const a = d.assembly('Pegs');
    a.instance({ part: { id: base.id } }, { grounded: true });
    const baseInst = (a.json.instances as Json[])[0]?.id as string;
    const seed = a.instance({ part: { id: peg.id } }, { at: [0, 0, 50] });
    const pattern = a.feature('core.asm.pattern', {
      of: { set: [pathOf(instancePath(seed))] },
      layout: {
        linear: {
          directions: [
            {
              direction: { axis: { axis: d.val('"x"'), reversed: d.flag(false) } },
              count: d.val('2'),
              spacing: { equal: { s: d.val('20 mm') } },
            },
          ],
        },
      },
      skip: { set: [] },
    });
    const copySteps = [instanceStep(seed), { op: { id: pattern }, key: { slot: { i: 1, j: 0 } } }];
    a.joint(
      'rigid',
      { frame: d.planeFrame(d.faceThrough(baseInst, baseBox, '+z')) },
      { frame: d.planeFrame(d.ref('face', pegBox, '-z', copySteps), { flip: true }) },
    );
    const ev = evaluate(d.document({ assembly: { id: a.id } }));
    expect(ev.pauses).toEqual([]);
    const asm = ev.assemblies.get(a.id) as AssemblyResult;
    expect(close(asm.nodes[2]?.placement.position as V3, [0, 0, 7])).toBe(true);
    expect(close(asm.nodes[1]?.placement.position as V3, [-20, 0, 7])).toBe(true);
  });
});
