/**
 * Pure-logic tests for the ComponentsPanel parameter form.
 * No DOM rendering — matches the existing test style (sketchSolver.test.ts).
 */

import { describe, expect, it } from 'vitest';
import type { ComponentManifest, ComponentParameter } from '@tweakcad/api-types';
import {
  clampNumber,
  coerceParameterValue,
  initialParameterValues,
} from './parameters.ts';

function manifest(parameters: ComponentParameter[]): ComponentManifest {
  return { schemaVersion: 1, parameters };
}

describe('initialParameterValues', () => {
  it('returns the manifest default for a well-formed number parameter', () => {
    const m = manifest([
      { name: 'length', label: 'Length', type: 'number', default: 20, range: [6, 120] },
    ]);
    expect(initialParameterValues(m)).toEqual({ length: 20 });
  });

  it('clamps an out-of-range numeric default to the range', () => {
    const m = manifest([
      { name: 'length', label: 'Length', type: 'number', default: 200, range: [6, 120] },
    ]);
    expect(initialParameterValues(m)).toEqual({ length: 120 });
  });

  it('falls back to range[0] when the default is missing for a number', () => {
    const m = manifest([
      { name: 'length', label: 'Length', type: 'number', default: undefined, range: [6, 120] },
    ]);
    expect(initialParameterValues(m)).toEqual({ length: 6 });
  });

  it('falls back to 0 when both default and range are missing for a number', () => {
    const m = manifest([
      { name: 'count', label: 'Count', type: 'number', default: undefined },
    ]);
    expect(initialParameterValues(m)).toEqual({ count: 0 });
  });

  it('uses the manifest default when it is in the allowed enum values', () => {
    const m = manifest([
      {
        name: 'grade',
        label: 'Grade',
        type: 'enum',
        default: '10.9',
        values: ['8.8', '10.9', '12.9'],
      },
    ]);
    expect(initialParameterValues(m)).toEqual({ grade: '10.9' });
  });

  it('falls back to first enum value when default is not in the value set', () => {
    const m = manifest([
      {
        name: 'grade',
        label: 'Grade',
        type: 'enum',
        default: 'unknown',
        values: ['8.8', '10.9', '12.9'],
      },
    ]);
    expect(initialParameterValues(m)).toEqual({ grade: '8.8' });
  });

  it('returns false for boolean parameter with a non-boolean default', () => {
    const m = manifest([
      { name: 'flag', label: 'Flag', type: 'boolean', default: 'maybe' },
    ]);
    expect(initialParameterValues(m)).toEqual({ flag: false });
  });

  it('returns the default for boolean parameter when properly typed', () => {
    const m = manifest([
      { name: 'flag', label: 'Flag', type: 'boolean', default: true },
    ]);
    expect(initialParameterValues(m)).toEqual({ flag: true });
  });

  it('returns the string default for string parameters', () => {
    const m = manifest([
      { name: 'note', label: 'Note', type: 'string', default: 'hello' },
    ]);
    expect(initialParameterValues(m)).toEqual({ note: 'hello' });
  });

  it('handles multiple parameters of mixed types', () => {
    const m = manifest([
      { name: 'length', label: 'Length', type: 'number', default: 20, range: [6, 120] },
      { name: 'grade', label: 'Grade', type: 'enum', default: '8.8', values: ['8.8', '10.9'] },
      { name: 'threaded', label: 'Threaded', type: 'boolean', default: true },
    ]);
    expect(initialParameterValues(m)).toEqual({
      length: 20,
      grade: '8.8',
      threaded: true,
    });
  });
});

describe('clampNumber', () => {
  it('returns the value unchanged when within range', () => {
    expect(clampNumber(50, [0, 100])).toBe(50);
  });

  it('clamps below the minimum to the minimum', () => {
    expect(clampNumber(-5, [0, 100])).toBe(0);
  });

  it('clamps above the maximum to the maximum', () => {
    expect(clampNumber(150, [0, 100])).toBe(100);
  });

  it('returns the value unchanged when no range is supplied', () => {
    expect(clampNumber(999, undefined)).toBe(999);
  });
});

describe('coerceParameterValue', () => {
  it('parses numeric strings and clamps to the range', () => {
    const param: ComponentParameter = {
      name: 'length',
      label: 'Length',
      type: 'number',
      default: 10,
      range: [0, 100],
    };
    expect(coerceParameterValue(param, '50')).toBe(50);
    expect(coerceParameterValue(param, '500')).toBe(100); // clamped
    expect(coerceParameterValue(param, '-5')).toBe(0); // clamped
  });

  it('rejects non-numeric input for number parameters', () => {
    const param: ComponentParameter = { name: 'l', label: 'L', type: 'number', default: 1 };
    expect(coerceParameterValue(param, 'abc')).toBeNull();
  });

  it('rejects enum values outside the allowed set', () => {
    const param: ComponentParameter = {
      name: 'grade',
      label: 'Grade',
      type: 'enum',
      default: '8.8',
      values: ['8.8', '10.9'],
    };
    expect(coerceParameterValue(param, '10.9')).toBe('10.9');
    expect(coerceParameterValue(param, '5.6')).toBeNull();
  });

  it('coerces truthy/falsy values to boolean', () => {
    const param: ComponentParameter = { name: 'f', label: 'F', type: 'boolean', default: false };
    expect(coerceParameterValue(param, true)).toBe(true);
    expect(coerceParameterValue(param, '')).toBe(false);
    expect(coerceParameterValue(param, 'on')).toBe(true);
  });

  it('coerces arbitrary input to string for string parameters', () => {
    const param: ComponentParameter = { name: 's', label: 'S', type: 'string', default: '' };
    expect(coerceParameterValue(param, 'hello')).toBe('hello');
    expect(coerceParameterValue(param, 42)).toBe('42');
  });
});
