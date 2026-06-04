/**
 * Tests for SetConfigurationRow / DeleteConfigurationRow /
 * SetActiveConfiguration handlers + applyActiveConfiguration merge helper.
 */
import { describe, expect, it } from 'vitest';
import { newProjectWithPart } from '../../document/factory.ts';
import type { CadProject, ParameterValue, ConfigurationRow } from '../../document/schema.ts';
import type { PartId } from '../../ids.ts';
import { partId } from '../../ids.ts';
import {
  setConfigurationRowHandler,
  deleteConfigurationRowHandler,
  setActiveConfigurationHandler,
  applyActiveConfiguration,
} from './configurationCommands.ts';

function makeProject(): CadProject {
  return newProjectWithPart('Test');
}

function firstPartId(project: CadProject): PartId {
  const ids = Object.keys(project.parts);
  if (ids.length === 0) throw new Error('test fixture has no parts');
  return ids[0] as PartId;
}

function makeRow(id: string, name: string, overrides: Record<string, string>): ConfigurationRow {
  return { id, name, overrides };
}

function seedParams(p: CadProject, partOnly = false): void {
  const partId = firstPartId(p);
  const D: ParameterValue = { name: 'D', expression: '4', unit: 'mm' };
  const L: ParameterValue = { name: 'L', expression: '20', unit: 'mm' };
  if (partOnly) {
    p.parts[partId]!.parameters.values['D'] = D;
    p.parts[partId]!.parameters.values['L'] = L;
  } else {
    p.parameters.values['D'] = D;
    p.parameters.values['L'] = L;
  }
}

describe('setConfigurationRowHandler.validate', () => {
  it('accepts a row whose overrides reference part-scoped params', () => {
    const p = makeProject();
    seedParams(p, true);
    const r = setConfigurationRowHandler.validate(
      { type: 'SetConfigurationRow', partId: firstPartId(p), row: makeRow('m3x10', 'M3×10', { D: '3', L: '10' }) },
      p,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects overrides on project-scope params (must be shadowed into part scope first)', () => {
    const p = makeProject();
    seedParams(p);
    const r = setConfigurationRowHandler.validate(
      { type: 'SetConfigurationRow', partId: firstPartId(p), row: makeRow('m3x10', 'M3×10', { D: '3' }) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_OVERRIDE');
  });

  it('accepts a row with empty overrides (a "use defaults" row)', () => {
    const p = makeProject();
    seedParams(p);
    const r = setConfigurationRowHandler.validate(
      { type: 'SetConfigurationRow', partId: firstPartId(p), row: makeRow('default', 'Default', {}) },
      p,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects unknown part', () => {
    const p = makeProject();
    const r = setConfigurationRowHandler.validate(
      { type: 'SetConfigurationRow', partId: partId('missing'), row: makeRow('m3', 'M3', {}) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('NOT_FOUND');
  });

  it('rejects empty row id', () => {
    const p = makeProject();
    const r = setConfigurationRowHandler.validate(
      { type: 'SetConfigurationRow', partId: firstPartId(p), row: makeRow('', 'Default', {}) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_ID');
  });

  it('rejects empty row name', () => {
    const p = makeProject();
    const r = setConfigurationRowHandler.validate(
      { type: 'SetConfigurationRow', partId: firstPartId(p), row: makeRow('row_1', '   ', {}) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_NAME');
  });

  it('rejects override that references an unknown parameter', () => {
    const p = makeProject();
    seedParams(p);
    const r = setConfigurationRowHandler.validate(
      { type: 'SetConfigurationRow', partId: firstPartId(p), row: makeRow('r', 'R', { wat: '5' }) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('UNKNOWN_PARAMETER');
  });

  it('rejects override on a choice-kind parameter', () => {
    const p = makeProject();
    seedParams(p, true);
    p.parts[firstPartId(p)]!.parameters.values['mode'] = {
      name: 'mode',
      expression: 'A',
      unit: 'none',
      kind: 'choice',
      options: ['A', 'B'],
    };
    const r = setConfigurationRowHandler.validate(
      { type: 'SetConfigurationRow', partId: firstPartId(p), row: makeRow('r', 'R', { mode: 'B' }) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_OVERRIDE');
  });

  it('rejects override with empty expression', () => {
    const p = makeProject();
    seedParams(p, true);
    const r = setConfigurationRowHandler.validate(
      { type: 'SetConfigurationRow', partId: firstPartId(p), row: makeRow('r', 'R', { D: '' }) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_EXPRESSION');
  });

  it('rejects override that introduces a cycle', () => {
    const p = makeProject();
    const id = firstPartId(p);
    p.parts[id]!.parameters.values['a'] = { name: 'a', expression: '10', unit: 'mm' };
    p.parts[id]!.parameters.values['b'] = { name: 'b', expression: 'a + 1', unit: 'mm' };
    const r = setConfigurationRowHandler.validate(
      { type: 'SetConfigurationRow', partId: id, row: makeRow('r', 'R', { a: 'b * 2' }) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_EXPRESSION');
  });

  it('rejects override with malformed expression', () => {
    const p = makeProject();
    seedParams(p, true);
    const r = setConfigurationRowHandler.validate(
      { type: 'SetConfigurationRow', partId: firstPartId(p), row: makeRow('r', 'R', { D: '3 + * 4' }) },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_EXPRESSION');
  });
});

describe('setConfigurationRowHandler.execute', () => {
  it('creates the configurations table on first row', () => {
    const p = makeProject();
    seedParams(p);
    const id = firstPartId(p);
    setConfigurationRowHandler.execute(p, {
      type: 'SetConfigurationRow',
      partId: id,
      row: makeRow('m3x10', 'M3×10', { D: '3', L: '10' }),
    });
    expect(p.parts[id]?.configurations).toEqual({
      active: null,
      rows: [{ id: 'm3x10', name: 'M3×10', overrides: { D: '3', L: '10' } }],
    });
  });

  it('upserts an existing row by id', () => {
    const p = makeProject();
    seedParams(p);
    const id = firstPartId(p);
    setConfigurationRowHandler.execute(p, {
      type: 'SetConfigurationRow',
      partId: id,
      row: makeRow('m3x10', 'M3×10', { D: '3', L: '10' }),
    });
    setConfigurationRowHandler.execute(p, {
      type: 'SetConfigurationRow',
      partId: id,
      row: makeRow('m3x10', 'M3×10 (updated)', { D: '3', L: '12' }),
    });
    expect(p.parts[id]?.configurations?.rows).toHaveLength(1);
    expect(p.parts[id]?.configurations?.rows[0]?.name).toBe('M3×10 (updated)');
    expect(p.parts[id]?.configurations?.rows[0]?.overrides['L']).toBe('12');
  });
});

describe('deleteConfigurationRowHandler', () => {
  it('removes the row and clears active when the active row is deleted', () => {
    const p = makeProject();
    seedParams(p);
    const id = firstPartId(p);
    setConfigurationRowHandler.execute(p, { type: 'SetConfigurationRow', partId: id, row: makeRow('m3', 'M3', { D: '3' }) });
    setActiveConfigurationHandler.execute(p, { type: 'SetActiveConfiguration', partId: id, rowId: 'm3' });
    deleteConfigurationRowHandler.execute(p, { type: 'DeleteConfigurationRow', partId: id, rowId: 'm3' });
    expect(p.parts[id]?.configurations?.rows).toHaveLength(0);
    expect(p.parts[id]?.configurations?.active).toBeNull();
  });

  it('keeps other rows intact', () => {
    const p = makeProject();
    seedParams(p);
    const id = firstPartId(p);
    setConfigurationRowHandler.execute(p, { type: 'SetConfigurationRow', partId: id, row: makeRow('m3', 'M3', { D: '3' }) });
    setConfigurationRowHandler.execute(p, { type: 'SetConfigurationRow', partId: id, row: makeRow('m4', 'M4', { D: '4' }) });
    deleteConfigurationRowHandler.execute(p, { type: 'DeleteConfigurationRow', partId: id, rowId: 'm3' });
    expect(p.parts[id]?.configurations?.rows.map(r => r.id)).toEqual(['m4']);
  });
});

describe('setActiveConfigurationHandler', () => {
  it('rejects non-existent row id', () => {
    const p = makeProject();
    seedParams(p);
    const id = firstPartId(p);
    setConfigurationRowHandler.execute(p, { type: 'SetConfigurationRow', partId: id, row: makeRow('m3', 'M3', { D: '3' }) });
    const r = setActiveConfigurationHandler.validate(
      { type: 'SetActiveConfiguration', partId: id, rowId: 'ghost' },
      p,
    );
    expect(r.ok).toBe(false);
  });

  it('accepts null (clears active)', () => {
    const p = makeProject();
    const r = setActiveConfigurationHandler.validate(
      { type: 'SetActiveConfiguration', partId: firstPartId(p), rowId: null },
      p,
    );
    expect(r.ok).toBe(true);
  });
});

describe('applyActiveConfiguration', () => {
  it('returns part.parameters unchanged when configurations is missing', () => {
    const p = makeProject();
    seedParams(p, true);
    const merged = applyActiveConfiguration(p.parts[firstPartId(p)]!);
    expect(merged.values['D']?.expression).toBe('4');
  });

  it('returns part.parameters unchanged when active is null', () => {
    const p = makeProject();
    seedParams(p, true);
    p.parts[firstPartId(p)]!.configurations = {
      active: null,
      rows: [{ id: 'r', name: 'R', overrides: { D: '99' } }],
    };
    const merged = applyActiveConfiguration(p.parts[firstPartId(p)]!);
    expect(merged.values['D']?.expression).toBe('4');
  });

  it('applies overrides from the active row, leaving non-overridden params unchanged', () => {
    const p = makeProject();
    seedParams(p, true);
    p.parts[firstPartId(p)]!.configurations = {
      active: 'r',
      rows: [{ id: 'r', name: 'M4', overrides: { D: '4' } }],
    };
    const merged = applyActiveConfiguration(p.parts[firstPartId(p)]!);
    expect(merged.values['D']?.expression).toBe('4');
    expect(merged.values['L']?.expression).toBe('20');
  });

  it('preserves the parameter\'s unit / public / description when overriding', () => {
    const p = makeProject();
    const id = firstPartId(p);
    p.parts[id]!.parameters.values['D'] = {
      name: 'D',
      expression: '4',
      unit: 'mm',
      public: true,
      description: 'Thread diameter',
    };
    p.parts[id]!.configurations = {
      active: 'r',
      rows: [{ id: 'r', name: 'M6', overrides: { D: '6' } }],
    };
    const merged = applyActiveConfiguration(p.parts[id]!);
    const d = merged.values['D']!;
    expect(d.expression).toBe('6');
    expect(d.public).toBe(true);
    expect(d.description).toBe('Thread diameter');
    expect(d.unit).toBe('mm');
  });

  it('treats a stale active id (row deleted out-of-band) as no-op', () => {
    const p = makeProject();
    seedParams(p, true);
    p.parts[firstPartId(p)]!.configurations = {
      active: 'ghost',
      rows: [],
    };
    const merged = applyActiveConfiguration(p.parts[firstPartId(p)]!);
    expect(merged.values['D']?.expression).toBe('4');
  });
});
