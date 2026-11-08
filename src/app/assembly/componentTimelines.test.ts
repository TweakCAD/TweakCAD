import { describe, expect, it } from 'vitest';
import type { Doc } from '@tweakcad/editor';
import type { FeatureRow, PartView } from '../features';
import { componentTimelines } from './componentTimelines';

const row = (id: string): FeatureRow => ({
  id,
  name: id,
  type: 'core.extrude',
  iconKey: 'extrude',
  suppressed: false,
  frozen: false,
  status: 'success',
  hidden: false,
  children: [],
});
const part = (id: string, name: string, features: string[]): PartView => ({
  id,
  name,
  features: features.map(row),
  rollbackIndex: features.length,
  groups: [],
});
const instance = (id: string, of: string) => ({ id, of: { part: { id: of } } });
const doc = (instances: unknown[]): Doc => ({ assemblies: [{ id: 'a', name: 'Robot', instances }] }) as unknown as Doc;

describe('componentTimelines', () => {
  it("lists the top-level component's items first and groups the others", () => {
    const parts = [part('p1', 'Robot', ['f1', 'f2']), part('p2', 'Arm', ['f3']), part('p3', 'Wheel', ['f4'])];
    const t = componentTimelines(doc([instance('i2', 'p2'), instance('i1', 'p1'), instance('i3', 'p3')]), 'a', parts);
    expect(t.top.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(t.rest.map((f) => f.id)).toEqual(['f3', 'f4']);
    expect(t.groups).toEqual([
      { id: 'component:p2', name: 'Arm', members: ['f3'] },
      { id: 'component:p3', name: 'Wheel', members: ['f4'] },
    ]);
    expect(t.instanceOf.get('f1')).toBe('i1');
    expect(t.instanceOf.get('f4')).toBe('i3');
  });

  it('lists a part placed many times once, to be edited at its first instance', () => {
    const t = componentTimelines(doc([instance('i1', 'p2'), instance('i2', 'p2')]), 'a', [part('p2', 'Arm', ['f3'])]);
    expect(t.rest.map((f) => f.id)).toEqual(['f3']);
    expect(t.instanceOf.get('f3')).toBe('i1');
  });

  it('leaves out a part with nothing on its timeline', () => {
    const t = componentTimelines(doc([instance('i1', 'p2')]), 'a', [part('p2', 'Arm', [])]);
    expect(t.groups).toEqual([]);
  });
});
