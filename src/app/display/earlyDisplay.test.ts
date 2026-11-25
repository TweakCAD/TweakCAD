import { describe, expect, it } from 'vitest';
import { earlyDisplay } from './earlyDisplay';
import type { EarlyBody } from '@tweakcad/worker/src/v2/service/types';

const body: EarlyBody = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  segments: new Float32Array(0),
};
const flag = (text: string) => ({ def: { expr: { grammar: 1, refs: {}, text } }, id: 'val_x' });
const turn = (deg: number) => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];

const doc = {
  parts: [{ id: 'part_a' }, { id: 'part_b' }],
  assemblies: [
    {
      id: 'asm_top',
      instances: [
        {
          id: 'inst_1',
          of: { part: { id: 'part_a' } },
          overrides: [],
          placement: { position: [10, 0, 0], rotation: [0, 0, 0, 1] },
        },
        {
          id: 'inst_2',
          of: { part: { id: 'part_b' } },
          overrides: [],
          placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
        },
        { id: 'inst_3', of: { part: { id: 'part_a' } }, overrides: [], suppressed: flag('true') },
        { id: 'inst_4', of: { part: { id: 'part_a' } }, overrides: [{ target: 'x' }] },
        {
          id: 'inst_5',
          of: { assembly: { id: 'asm_sub' } },
          overrides: [],
          placement: { position: [0, 5, 0], rotation: turn(90) },
        },
      ],
    },
    {
      id: 'asm_sub',
      instances: [
        {
          id: 'inst_6',
          of: { part: { id: 'part_a' } },
          overrides: [],
          placement: { position: [1, 0, 0], rotation: [0, 0, 0, 1] },
        },
      ],
    },
  ],
};

describe('earlyDisplay', () => {
  it('shows the instances of the parts built so far where the document stores them', () => {
    const d = earlyDisplay({ parts: [{ part: 'part_a', bodies: [body] }] }, doc);
    expect(d.definitions).toHaveLength(1);
    expect(d.parts).toEqual({ part_a: 0 });
    const top = d.assemblies.find((a) => a.id === 'asm_top');
    // part_b is not built yet; inst_3 is suppressed; inst_4 builds a variant of its own.
    expect(top?.instances.map((i) => i.path)).toEqual([['inst_1'], ['inst_5', 'inst_6']]);
    expect(top?.instances[0]?.placement.position).toEqual([10, 0, 0]);
    // A nested instance: (1, 0, 0) turned 90° about z, then moved by (0, 5, 0).
    const nested = top?.instances[1]?.placement.position ?? [];
    expect(nested[0]).toBeCloseTo(0);
    expect(nested[1]).toBeCloseTo(6);
    expect(nested[2]).toBeCloseTo(0);
  });

  it('holds nothing to pick', () => {
    const d = earlyDisplay({ parts: [{ part: 'part_a', bodies: [body] }] }, doc);
    expect(d.entities).toEqual([]);
    expect(d.definitions[0]?.bodies[0]?.mesh.faces.length).toBe(0);
  });
});
