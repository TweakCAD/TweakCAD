/**
 * Tests for SetParameter / DeleteParameter command handlers.
 *
 * Covers the validation surface: name format, expression parse,
 * cycle detection (uses the same resolver as the build pipeline),
 * scope routing (project vs part), and execute upsert/delete behavior.
 */
import { describe, expect, it } from 'vitest';
import { newProjectWithPart } from '../../document/factory.ts';
import type { CadProject, ParameterValue } from '../../document/schema.ts';
import type { PartId } from '../../ids.ts';
import { partId } from '../../ids.ts';
import { setParameterHandler, deleteParameterHandler } from './parameterCommands.ts';

function makeProject(): CadProject {
  return newProjectWithPart('Test');
}

function firstPartId(project: CadProject): PartId {
  const ids = Object.keys(project.parts);
  if (ids.length === 0) throw new Error('test fixture has no parts');
  return ids[0] as PartId;
}

function valueOf(name: string, expression: string, unit: ParameterValue['unit'] = 'mm'): ParameterValue {
  return { name, expression, unit };
}

describe('setParameterHandler.validate', () => {
  it('accepts a simple numeric expression at project scope', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'length', value: valueOf('length', '100') },
      p,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts an expression referencing an existing parameter', () => {
    const p = makeProject();
    p.parameters.values['width'] = valueOf('width', '50');
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'length', value: valueOf('length', 'width * 2 + 5') },
      p,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects empty name', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: '   ', value: valueOf('   ', '1') },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_NAME');
  });

  it('rejects name starting with a digit', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: '1width', value: valueOf('1width', '1') },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_NAME');
  });

  it('rejects mismatch between command.name and value.name', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'length', value: valueOf('width', '1') },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_NAME');
  });

  it('rejects empty expression', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'length', value: valueOf('length', '') },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_EXPRESSION');
  });

  it('rejects malformed expression', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'length', value: valueOf('length', '100 + * 5') },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_EXPRESSION');
  });

  it('rejects reference to an unknown parameter', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'length', value: valueOf('length', 'undefinedVar + 1') },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_EXPRESSION');
  });

  it('rejects a cycle introduced by editing an existing parameter', () => {
    const p = makeProject();
    p.parameters.values['a'] = valueOf('a', '10');
    p.parameters.values['b'] = valueOf('b', 'a + 1');
    // Now try to make a depend on b — would close the cycle.
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'a', value: valueOf('a', 'b * 2') },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_EXPRESSION');
  });

  it('rejects self-reference', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'a', value: valueOf('a', 'a + 1') },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_EXPRESSION');
  });

  it('rejects invalid unit', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'length', value: { name: 'length', expression: '1', unit: 'lightyear' as unknown as ParameterValue['unit'] } },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_UNIT');
  });

  it('rejects unknown part scope', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: partId('does_not_exist'), name: 'length', value: valueOf('length', '1') },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('NOT_FOUND');
  });

  it('accepts part-scoped parameter that shadows a project parameter', () => {
    const p = makeProject();
    p.parameters.values['width'] = valueOf('width', '100');
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: firstPartId(p), name: 'width', value: valueOf('width', '50') },
      p,
    );
    expect(r.ok).toBe(true);
  });
});

describe('setParameterHandler.execute', () => {
  it('creates a new project-scope parameter', () => {
    const p = makeProject();
    setParameterHandler.execute(p, {
      type: 'SetParameter',
      scope: 'project',
      name: 'length',
      value: valueOf('length', '100'),
    });
    expect(p.parameters.values['length']).toEqual(valueOf('length', '100'));
  });

  it('updates an existing parameter in place', () => {
    const p = makeProject();
    p.parameters.values['length'] = valueOf('length', '50');
    setParameterHandler.execute(p, {
      type: 'SetParameter',
      scope: 'project',
      name: 'length',
      value: valueOf('length', '200', 'mm'),
    });
    expect(p.parameters.values['length']?.expression).toBe('200');
  });

  it('writes to the part-scoped table when scope is a PartId', () => {
    const p = makeProject();
    const id = firstPartId(p);
    setParameterHandler.execute(p, {
      type: 'SetParameter',
      scope: id,
      name: 'thickness',
      value: valueOf('thickness', '5'),
    });
    expect(p.parts[id]?.parameters.values['thickness']?.expression).toBe('5');
    expect(p.parameters.values['thickness']).toBeUndefined();
  });

  it('updates metadata.updatedAt', () => {
    const p = makeProject();
    const before = p.metadata.updatedAt;
    // Tick the clock at least one ms so the comparison is reliable on fast machines.
    const futureNow = new Date(Date.parse(before) + 5).toISOString();
    const realNow = Date.prototype.toISOString;
    Date.prototype.toISOString = function () { return futureNow; };
    try {
      setParameterHandler.execute(p, {
        type: 'SetParameter',
        scope: 'project',
        name: 'length',
        value: valueOf('length', '1'),
      });
    } finally {
      Date.prototype.toISOString = realNow;
    }
    expect(p.metadata.updatedAt).toBe(futureNow);
  });
});

describe('setParameterHandler with kind=choice', () => {
  function choice(name: string, expression: string, options: string[]): ParameterValue {
    return { name, expression, unit: 'none', kind: 'choice', options };
  }

  it('accepts a valid choice parameter with non-empty options and a selected value', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'head_type', value: choice('head_type', 'hex', ['hex', 'socket', 'flat']) },
      p,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a choice parameter with empty expression (no selection yet)', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'head_type', value: choice('head_type', '', ['hex', 'socket']) },
      p,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects choice without options', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'head_type', value: { name: 'head_type', expression: 'hex', unit: 'none', kind: 'choice' } },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_OPTIONS');
  });

  it('rejects choice with empty options array', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'head_type', value: choice('head_type', '', []) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_OPTIONS');
  });

  it('rejects choice with duplicate options', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'head_type', value: choice('head_type', 'hex', ['hex', 'hex', 'socket']) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_OPTIONS');
  });

  it('rejects choice whose expression is not in the options list', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'head_type', value: choice('head_type', 'pozidriv', ['hex', 'socket']) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_EXPRESSION');
  });

  it('rejects a numeric parameter that references a choice parameter', () => {
    const p = makeProject();
    p.parameters.values['mode'] = choice('mode', 'A', ['A', 'B']);
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'thickness', value: { name: 'thickness', expression: 'mode * 2', unit: 'mm' } },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_EXPRESSION');
    expect(r.ok ? '' : r.error.message).toMatch(/choice parameter/);
  });

  it('rejects options on a number-kind parameter', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      { type: 'SetParameter', scope: 'project', name: 'width', value: { name: 'width', expression: '100', unit: 'mm', options: ['a', 'b'] } },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_OPTIONS');
  });
});

describe('setParameterHandler with public/description fields', () => {
  it('accepts public:true and description fields', () => {
    const p = makeProject();
    const r = setParameterHandler.validate(
      {
        type: 'SetParameter',
        scope: 'project',
        name: 'length',
        value: { name: 'length', expression: '100', unit: 'mm', public: true, description: 'Plate length' },
      },
      p,
    );
    expect(r.ok).toBe(true);
  });

  it('round-trips public and description through execute', () => {
    const p = makeProject();
    setParameterHandler.execute(p, {
      type: 'SetParameter',
      scope: 'project',
      name: 'length',
      value: { name: 'length', expression: '100', unit: 'mm', public: true, description: 'Plate length' },
    });
    expect(p.parameters.values['length']).toEqual({
      name: 'length',
      expression: '100',
      unit: 'mm',
      public: true,
      description: 'Plate length',
    });
  });
});

describe('deleteParameterHandler', () => {
  it('rejects when parameter does not exist', () => {
    const p = makeProject();
    const r = deleteParameterHandler.validate(
      { type: 'DeleteParameter', scope: 'project', name: 'ghost' },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('NOT_FOUND');
  });

  it('rejects unknown part scope', () => {
    const p = makeProject();
    const r = deleteParameterHandler.validate(
      { type: 'DeleteParameter', scope: partId('missing'), name: 'whatever' },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('NOT_FOUND');
  });

  it('removes the parameter from project scope', () => {
    const p = makeProject();
    p.parameters.values['gone'] = valueOf('gone', '1');
    deleteParameterHandler.execute(p, { type: 'DeleteParameter', scope: 'project', name: 'gone' });
    expect(p.parameters.values['gone']).toBeUndefined();
  });

  it('removes the parameter from part scope and leaves project alone', () => {
    const p = makeProject();
    const id = firstPartId(p);
    p.parameters.values['length'] = valueOf('length', '50');
    p.parts[id]!.parameters.values['length'] = valueOf('length', '100');
    deleteParameterHandler.execute(p, { type: 'DeleteParameter', scope: id, name: 'length' });
    expect(p.parts[id]?.parameters.values['length']).toBeUndefined();
    expect(p.parameters.values['length']?.expression).toBe('50');
  });

  // Deleting a parameter another row references used to be accepted:
  // `resolveAllParameters` then fails for the whole table, so every
  // feature in the part reports 'blocked' with nothing naming the cause.
  it('rejects deleting a parameter another project row references', () => {
    const p = makeProject();
    p.parameters.values['a'] = valueOf('a', '10');
    p.parameters.values['b'] = valueOf('b', 'a * 2');
    const r = deleteParameterHandler.validate(
      { type: 'DeleteParameter', scope: 'project', name: 'a' },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('HAS_DEPENDENTS');
    expect(r.ok ? '' : r.error.message).toContain('b');
  });

  it('rejects deleting a project parameter a part row references', () => {
    const p = makeProject();
    const id = firstPartId(p);
    p.parameters.values['wall'] = valueOf('wall', '2');
    p.parts[id]!.parameters.values['rib'] = valueOf('rib', 'wall * 3');
    const r = deleteParameterHandler.validate(
      { type: 'DeleteParameter', scope: 'project', name: 'wall' },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('HAS_DEPENDENTS');
    expect(r.ok ? '' : r.error.message).toContain('rib');
  });

  it('allows deleting a project parameter a part shadows', () => {
    const p = makeProject();
    const id = firstPartId(p);
    p.parameters.values['wall'] = valueOf('wall', '2');
    // The part defines its own `wall`, so `rib` never resolved against
    // the project row and deleting it changes nothing.
    p.parts[id]!.parameters.values['wall'] = valueOf('wall', '5');
    p.parts[id]!.parameters.values['rib'] = valueOf('rib', 'wall * 3');
    const r = deleteParameterHandler.validate(
      { type: 'DeleteParameter', scope: 'project', name: 'wall' },
      p,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects deleting a part parameter a sibling part row references', () => {
    const p = makeProject();
    const id = firstPartId(p);
    p.parts[id]!.parameters.values['bore'] = valueOf('bore', '8');
    p.parts[id]!.parameters.values['clearance'] = valueOf('clearance', 'bore + 1');
    const r = deleteParameterHandler.validate(
      { type: 'DeleteParameter', scope: id, name: 'bore' },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('HAS_DEPENDENTS');
  });

  it('allows deleting a part parameter that only shadowed a project row', () => {
    const p = makeProject();
    const id = firstPartId(p);
    p.parameters.values['bore'] = valueOf('bore', '6');
    p.parts[id]!.parameters.values['bore'] = valueOf('bore', '8');
    p.parts[id]!.parameters.values['clearance'] = valueOf('clearance', 'bore + 1');
    const r = deleteParameterHandler.validate(
      { type: 'DeleteParameter', scope: id, name: 'bore' },
      p,
    );
    // `clearance` still resolves — against the project's 6 instead of 8.
    expect(r.ok).toBe(true);
  });

  it('allows deleting a parameter nothing references', () => {
    const p = makeProject();
    p.parameters.values['a'] = valueOf('a', '10');
    p.parameters.values['b'] = valueOf('b', '20');
    const r = deleteParameterHandler.validate(
      { type: 'DeleteParameter', scope: 'project', name: 'a' },
      p,
    );
    expect(r.ok).toBe(true);
  });

  it('does not count the deleted row\'s own expression as a dependent', () => {
    const p = makeProject();
    // A self-referencing row can't exist (the cycle check rejects it on
    // write), but a row whose name appears in its own expression text
    // must not block its own deletion.
    p.parameters.values['a'] = valueOf('a', '10');
    p.parameters.values['scale_a'] = valueOf('scale_a', '2');
    const r = deleteParameterHandler.validate(
      { type: 'DeleteParameter', scope: 'project', name: 'a' },
      p,
    );
    // `scale_a` contains "a" as a substring but not as an identifier.
    expect(r.ok).toBe(true);
  });
});

describe('deleteParameterHandler.validate — sketch dimensions', () => {
  // An unresolvable sketch dimension does not fail its feature: the sketch
  // keeps its last solved shape. So deleting the parameter it uses would go
  // through and quietly stop the parameter driving anything.
  function withDrivenSketch(expression: string): { p: CadProject; part: PartId } {
    const p = makeProject();
    const part = firstPartId(p);
    p.parts[part]!.timeline.push({
      id: 'f_sketch' as never,
      type: 'sketch',
      name: 'Bolt circle',
      version: 1,
      enabled: true,
      visible: true,
      inputs: {
        plane: { type: 'defaultPlane', name: 'XY' },
        editorModel: {
          points: [],
          geometries: [],
          constraints: [{ id: 'c1', type: 'distance', pointA: 'p1', pointB: 'p2', value: 40, expression }],
        },
      },
      dependsOn: [],
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    } as never);
    return { p, part };
  }

  it('rejects deleting a project parameter a sketch dimension uses', () => {
    const { p } = withDrivenSketch('pcd / 2');
    p.parameters.values['pcd'] = valueOf('pcd', '80');
    const r = deleteParameterHandler.validate({ type: 'DeleteParameter', scope: 'project', name: 'pcd' }, p);
    expect(r.ok ? '' : r.error.code).toBe('HAS_DEPENDENTS');
    expect(r.ok ? '' : r.error.message).toContain('Bolt circle (sketch dimension)');
  });

  it('rejects deleting a part parameter a sketch dimension in that part uses', () => {
    const { p, part } = withDrivenSketch('pcd');
    p.parts[part]!.parameters.values['pcd'] = valueOf('pcd', '80');
    const r = deleteParameterHandler.validate({ type: 'DeleteParameter', scope: part, name: 'pcd' }, p);
    expect(r.ok ? '' : r.error.code).toBe('HAS_DEPENDENTS');
  });

  it('allows it when a part row shadows the project row, since the sketch resolves against the part', () => {
    const { p, part } = withDrivenSketch('pcd');
    p.parameters.values['pcd'] = valueOf('pcd', '80');
    p.parts[part]!.parameters.values['pcd'] = valueOf('pcd', '60');
    const r = deleteParameterHandler.validate({ type: 'DeleteParameter', scope: 'project', name: 'pcd' }, p);
    expect(r.ok).toBe(true);
  });

  it('allows deleting a parameter no dimension uses', () => {
    const { p } = withDrivenSketch('width');
    p.parameters.values['pcd'] = valueOf('pcd', '80');
    p.parameters.values['width'] = valueOf('width', '10');
    const r = deleteParameterHandler.validate({ type: 'DeleteParameter', scope: 'project', name: 'pcd' }, p);
    expect(r.ok).toBe(true);
  });
});
