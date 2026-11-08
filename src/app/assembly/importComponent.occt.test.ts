/**
 * File ▸ Import Component end to end on the real kernel, with the fastener
 * fixtures as the files: a hex bolt imported into an assembly, joined on a
 * base by a face and a round edge, resized through Edit Component (its
 * Size row and its length), saved and reopened; and imported into a part as
 * a derive, with a slot sketched on its head that follows the head when the
 * Size changes. The joint and the sketch reference the component's
 * geometry, and keep doing so when the component's parameters change.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDocument, saveDocument, type Json } from '@tweakcad/editor';
import { readDocument } from '@tweakcad/format';
import type { Display, Placement } from '@tweakcad/worker/src/v2/service/types';
import { circleEdge, loadKernel, planeFace, session, type Kernel, type Session } from '../../fixtures/harness';
import { assemblyOf, indicesOf, rowsOf } from './assembly';
import { commitSolved } from './commit';
import { componentEditCommands, readComponentEdit, type ComponentSite } from './componentEdit';
import { importComponent } from './importComponent';
import { jointCommands, jointEnd, newJointForm } from './joints';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolvePath(HERE, '../../../lib/testing/fixtures/v2');
const SOLVER = resolvePath(HERE, '../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm');

let kernel: Kernel;
beforeAll(async () => {
  kernel = await loadKernel(realpathSync(SOLVER));
}, 60_000);
afterAll(() => {
  kernel.service.release();
  kernel.k.releaseAll();
});

const fixture = (name: string) => ({
  name: `${name}.cadjson`,
  bytes: new Uint8Array(readFileSync(resolvePath(FIXTURES, `${name}.cadjson`))),
});

/** Across the corners of a hex `s` across flats. */
const corners = (s: number) => (2 * s) / Math.sqrt(3);

function rotate(q: readonly number[], v: readonly number[]): number[] {
  const [x, y, z, w] = q as [number, number, number, number];
  const [a, b, c] = v as [number, number, number];
  // v + 2w(q × v) + 2 q × (q × v)
  const t = [2 * (y * c - z * b), 2 * (z * a - x * c), 2 * (x * b - y * a)];
  return [
    a + w * t[0]! + (y * t[2]! - z * t[1]!),
    b + w * t[1]! + (z * t[0]! - x * t[2]!),
    c + w * t[2]! + (x * t[1]! - y * t[0]!),
  ];
}

/** The box round an instance's bodies, in the assembly. */
function placedBox(display: Display, assembly: string, instance: string): { min: number[]; max: number[] } {
  const index = indicesOf(display, assembly, instance)[0] as number;
  const placed = display.assemblies.find((a) => a.id === assembly)?.instances[index] as {
    definition: number;
    placement: Placement;
  };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const body of display.definitions[placed.definition]?.bodies ?? []) {
    const p = body.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const r = rotate(placed.placement.rotation, [p[i]!, p[i + 1]!, p[i + 2]!]).map(
        (c, j) => c + (placed.placement.position[j] as number),
      );
      r.forEach((c, j) => {
        min[j] = Math.min(min[j] as number, c);
        max[j] = Math.max(max[j] as number, c);
      });
    }
  }
  return { min, max };
}

async function shown(t: Session): Promise<Display> {
  const d = await t.display();
  expect(d.pauses).toEqual([]);
  expect(d.stale).toEqual([]);
  return d;
}

async function edit(
  t: Session,
  site: ComponentSite,
  change: (
    e: NonNullable<ReturnType<typeof readComponentEdit>>,
  ) => Partial<NonNullable<ReturnType<typeof readComponentEdit>>>,
) {
  const e = readComponentEdit(t.s.editor.document, site);
  if (!e) throw new Error('not a component');
  expect(
    await commitSolved(t.s, 'Edit component', componentEditCommands(t.s.editor.document, site, { ...e, ...change(e) })),
  ).toEqual({ ok: true });
}

const sizeOf = (e: NonNullable<ReturnType<typeof readComponentEdit>>) =>
  e.configurations.find((c) => c.input.name === 'Size') as (typeof e.configurations)[number];
const paramOf = (e: NonNullable<ReturnType<typeof readComponentEdit>>, name: string) =>
  e.params.find((p) => p.name === name) as (typeof e.params)[number];

describe('importing a fastener file as a component', { timeout: 180_000 }, () => {
  it('places it in an assembly, joins it, resizes it by Size and length, and keeps it through save and reopen', async () => {
    const t = await session(kernel, 'Host', 301);
    expect(
      (
        await t.call<{ status: string }>('feature_primitive', {
          shape: 'box',
          width: 40,
          depth: 40,
          height: 10,
          position: [0, 0, 5],
        })
      ).status,
    ).toBe('ok');
    const asm = (await t.call<{ assembly: string }>('assembly_create', { name: 'Host assembly', parts: [t.part] }))
      .assembly;
    expect(await importComponent(t.s, fixture('hex-bolt-iso4017'))).toEqual({
      ok: true,
      name: 'Hex bolt ISO 4017',
      into: 'assembly',
    });
    const instances = rowsOf(assemblyOf(t.s.editor.document, asm), 'instances');
    expect(instances).toHaveLength(2);
    const bolt = String((instances[1] as Json).id);
    const site = { assembly: asm, instance: bolt };
    expect((t.s.editor.document.library as Json[]).map((e) => [e.name, e.kind, e.source])).toEqual([
      ['Hex bolt ISO 4017', 'document', { local: {} }],
    ]);

    // The component's public parameters and Size choice, as Edit Component shows them.
    const read = readComponentEdit(t.s.editor.document, site);
    expect(read?.params.map((p) => p.name).sort()).toEqual(['L', 'd', 'k', 'sw', 'thread']);
    expect(read && sizeOf(read)).toMatchObject({ options: ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12'], own: 'M6' });

    // The bolt's head stands on the base's top, on a revolute joint from the base's top face to the round edge under its head.
    let d = await shown(t);
    const baseIndex = indicesOf(d, asm, String((instances[0] as Json).id))[0] as number;
    const boltIndex = indicesOf(d, asm, bolt)[0] as number;
    const defOf = (i: number) => d.assemblies.find((a) => a.id === asm)?.instances[i]?.definition as number;
    const top = await jointEnd(
      t.s,
      {
        key: await planeFace(t.s, d, defOf(baseIndex), [0, 0, 1], [0, 0, 10]),
        instance: { assembly: asm, index: baseIndex },
      },
      'Base',
    );
    const under = await jointEnd(
      t.s,
      { key: await circleEdge(t.s, d, defOf(boltIndex), [0, 0, 0], 3), instance: { assembly: asm, index: boltIndex } },
      'Bolt',
    );
    if ('problem' in top || 'problem' in under) throw new Error('no joint end');
    const made = jointCommands(t.s.editor, asm, { ...newJointForm(), kind: 'revolute', a: top, b: under });
    if (!made.ok) throw new Error(made.message);
    expect(await commitSolved(t.s, 'Add joint', made.commands)).toEqual({ ok: true });
    d = await shown(t);
    let box = placedBox(d, asm, bolt);
    expect(box.min[2]).toBeCloseTo(10 - 30, 3);
    expect(box.max[2]).toBeCloseTo(10 + 4, 3);
    expect(box.max[0]! - box.min[0]!).toBeCloseTo(corners(10), 3);

    // M10 and 50 long: the joint, on the component's geometry, still holds the head on the base.
    await edit(t, site, (e) => ({
      rows: { [sizeOf(e).input.id]: 'M10' },
      values: { ...e.values, [paramOf(e, 'L').id]: '50' },
    }));
    d = await shown(t);
    box = placedBox(d, asm, bolt);
    expect(box.min[2]).toBeCloseTo(10 - 50, 3);
    expect(box.max[2]).toBeCloseTo(10 + 6.4, 3);
    expect(box.max[0]! - box.min[0]!).toBeCloseTo(corners(16), 3);
    expect(readDocument(t.s.editor.document).refused).toBe(false);

    // Saved and opened again, it evaluates to the same.
    const text = saveDocument(t.s.editor.document);
    const reopened = loadDocument(text);
    if (!reopened.ok) throw new Error(reopened.message);
    const again = await session(kernel, 'Host', 302, reopened.document);
    const d2 = await shown(again);
    const box2 = placedBox(d2, asm, bolt);
    box2.min.forEach((c, i) => expect(c).toBeCloseTo(box.min[i] as number, 6));
    box2.max.forEach((c, i) => expect(c).toBeCloseTo(box.max[i] as number, 6));
    const kept = readComponentEdit(again.s.editor.document, site);
    expect(kept && kept.rows[sizeOf(kept).input.id]).toBe('M10');
    expect(saveDocument(again.s.editor.document)).toBe(text);
  });

  it('derives it into a part, where a slot cut on its head follows the head to a new Size, and keeps it through save and reopen', async () => {
    const t = await session(kernel, 'Slotted', 303);
    expect(await importComponent(t.s, fixture('hex-bolt-iso4017'))).toEqual({
      ok: true,
      name: 'Hex bolt ISO 4017',
      into: 'part',
    });
    const derive = ((t.s.editor.document.parts as Json[])[0]?.timeline as Json[]).find(
      (f) => f.type === 'core.derive',
    ) as Json;
    expect(derive).toBeDefined();
    type Body = { handle: string; volume: number; min: number[]; max: number[] };
    const body = async () => {
      const all = (await t.call<{ bodies: Body[] }>('list_bodies')).bodies;
      expect(all).toHaveLength(1);
      return all[0] as Body;
    };
    const whole = await body();
    expect(whole.max[2]).toBeCloseTo(4, 6);
    const heads = (
      await t.call<{ faces: { handle: string; centroid: number[] }[] }>('list_faces', {
        body: whole.handle,
        normal: [0, 0, 1],
      })
    ).faces;
    const head = heads.sort((a, b) => (b.centroid[2] as number) - (a.centroid[2] as number))[0]?.handle;
    const slot = await t.call<{ sketch: string }>('sketch_create', { on: head });
    await t.call('sketch_draw_rectangle', { sketch: slot.sketch, from: [-8, -0.6], to: [8, 0.6] });
    expect(
      (
        await t.call<{ status: string }>('feature_extrude', {
          sketch: slot.sketch,
          distance: 1.5,
          reversed: true,
          operation: 'cut',
        })
      ).status,
    ).toBe('ok');
    const slotted = await body();
    expect(slotted.volume).toBeLessThan(whole.volume);
    const floorAt = async () => {
      const b = await body();
      const up = (
        await t.call<{ faces: { centroid: number[] }[] }>('list_faces', { body: b.handle, normal: [0, 0, 1] })
      ).faces.map((f) => f.centroid[2] as number);
      return { top: Math.max(...up), floor: Math.min(...up), body: b };
    };
    expect(await floorAt()).toMatchObject({ top: expect.closeTo(4, 6), floor: expect.closeTo(2.5, 6) });

    // M10: the head is 6.4 high, and the slot, sketched on its top, is cut from there.
    await edit(t, { feature: derive.id as string }, (e) => ({ rows: { [sizeOf(e).input.id]: 'M10' } }));
    await shown(t);
    const after = await floorAt();
    expect(after.top).toBeCloseTo(6.4, 6);
    expect(after.floor).toBeCloseTo(4.9, 6);
    expect(after.body.max[0]! - after.body.min[0]!).toBeCloseTo(corners(16), 3);

    const text = saveDocument(t.s.editor.document);
    const reopened = loadDocument(text);
    if (!reopened.ok) throw new Error(reopened.message);
    const again = await session(kernel, 'Slotted', 304, reopened.document);
    await shown(again);
    const [b2] = (await again.call<{ bodies: Body[] }>('list_bodies')).bodies;
    expect(b2?.volume).toBeCloseTo(after.body.volume, 6);
  });
});
