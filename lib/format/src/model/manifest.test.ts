import { describe, expect, it } from 'vitest';
import { manifestHash, manifestOf } from './manifest';

type Json = Record<string, unknown>;

const val = (id: string, text: string) => ({ id, def: { expr: { text, grammar: 1, refs: {} } } });

function doc(): Json {
  return {
    metadata: { name: 'Test' },
    parameters: [
      {
        id: 'tbl_1',
        name: 'Sizes',
        parameters: [{ id: 'par_1', name: 'gap', value: val('val_9', '2 mm'), description: 'a gap' }],
      },
    ],
    parts: [
      {
        id: 'part_a',
        name: 'Plate',
        timeline: [
          {
            id: 'feat_1',
            name: 'Sketch',
            command: { alone: {} },
            inputs: {
              points: [{ id: 'pt_1', x: 1, y: 2 }],
              constraints: [{ id: 'con_1', value: val('val_1', '10 mm'), solved: 10, label: { auto: {} } }],
            },
          },
        ],
        contexts: [
          {
            id: 'ctx_1',
            assembly: { id: 'asm_1' },
            at: { path: [] },
            captured: { set: [] },
            source: 'x',
            policy: 'manual',
            capturedAt: 't',
          },
        ],
        attributes: [{ id: 'attr_1' }],
      },
      { id: 'part_b', name: 'Unused', timeline: [] },
    ],
    assemblies: [
      {
        id: 'asm_1',
        name: 'Top',
        instances: [
          {
            id: 'inst_1',
            name: 'Plate 1',
            of: { part: { id: 'part_a' } },
            placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
          },
        ],
        joints: [{ id: 'jnt_1', kind: 'revolute', state: { rz: 30 } }],
      },
    ],
    library: [{ id: 'lib_1', name: 'Steel' }],
  };
}

describe('manifestOf', () => {
  it('holds what the assembly reaches, without presentation or solver state', () => {
    const m = manifestOf(doc(), 'asm_1');
    expect((m.parts as Json[]).map((p) => p.id)).toEqual(['part_a']);
    expect(m.library).toEqual([]);
    const part = (m.parts as Json[])[0] as Json;
    expect(part.name).toBeUndefined();
    expect(part.attributes).toBeUndefined();
    expect(part.contexts).toEqual([{ id: 'ctx_1', at: { path: [] } }]);
    const sketch = (part.timeline as Json[])[0] as Json;
    expect(sketch.command).toBeUndefined();
    expect(((sketch.inputs as Json).points as Json[])[0]).toEqual({ id: 'pt_1' });
    expect(((sketch.inputs as Json).constraints as Json[])[0]).toEqual({ id: 'con_1', value: val('val_1', '10 mm') });
    expect((((m.assemblies as Json[])[0] as Json).instances as Json[])[0]).toEqual({
      id: 'inst_1',
      of: { part: { id: 'part_a' } },
    });
  });

  it('keeps its hash through solver and presentation edits, and changes it for a design edit', () => {
    const base = manifestHash(doc(), 'asm_1');
    const moved = doc();
    ((((moved.assemblies as Json[])[0] as Json).instances as Json[])[0] as Json).placement = {
      position: [5, 0, 0],
      rotation: [0, 0, 0, 1],
    };
    (((moved.assemblies as Json[])[0] as Json).joints as Json[])[0]!.state = { rz: 60 };
    ((moved.parts as Json[])[0] as Json).name = 'Renamed';
    ((moved.parts as Json[])[1] as Json).timeline = [{ id: 'feat_9' }];
    expect(manifestHash(moved, 'asm_1')).toBe(base);

    const edited = doc();
    const sketch = (((edited.parts as Json[])[0] as Json).timeline as Json[])[0] as Json;
    ((sketch.inputs as Json).constraints as Json[])[0]!.value = val('val_1', '12 mm');
    expect(manifestHash(edited, 'asm_1')).not.toBe(base);
  });
});
