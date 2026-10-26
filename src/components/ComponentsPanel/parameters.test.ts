/**
 * The configure form's inputs and outputs.
 *
 * Everything here reads from the component's own document — its `public`
 * parameters and configuration rows. There is no catalog manifest in the
 * picture: a component is a project, and its parameter table already says
 * what is adjustable.
 */

import { describe, expect, it } from 'vitest';
import { hexBoltComponent } from '@tweakcad/testing/src/componentFixtures.ts';
import type { CadPart, CadProject } from '@tweakcad/core/src/document/schema.ts';
import {
  componentPart,
  configurationRows,
  initialParameterValues,
  isAllowedChoice,
  overridesFrom,
  publicParameters,
} from './parameters.ts';

function sourcePart(source: CadProject): CadPart {
  const part = componentPart(source);
  if (!part) throw new Error('test setup: component has no part');
  return part;
}

describe('componentPart', () => {
  it('returns the single part of a component', () => {
    expect(sourcePart(hexBoltComponent()).name).toBe('Bolt');
  });

  it('returns null for a document with no parts', () => {
    const empty = { ...hexBoltComponent(), parts: {} };
    expect(componentPart(empty)).toBeNull();
  });
});

describe('publicParameters', () => {
  it('offers only what the author marked public, in declaration order', () => {
    // `headHeight` is derived from the other two — showing it would invite
    // the user to break the relationship the author built.
    expect(publicParameters(sourcePart(hexBoltComponent())).map(p => p.name))
      .toEqual(['length', 'grade']);
  });

  it('is empty for a component whose author published nothing', () => {
    const source = hexBoltComponent();
    const part = sourcePart(source);
    for (const param of Object.values(part.parameters.values)) delete param.public;
    expect(publicParameters(part)).toEqual([]);
  });
});

describe('configurationRows', () => {
  it('reads the named sizes off the component', () => {
    expect(configurationRows(sourcePart(hexBoltComponent())).map(r => r.name))
      .toEqual(['M5×20', 'M5×40']);
  });

  it('is empty when the author defined none', () => {
    const part = sourcePart(hexBoltComponent());
    delete part.configurations;
    expect(configurationRows(part)).toEqual([]);
  });
});

describe('initialParameterValues', () => {
  it('seeds from the chosen configuration row', () => {
    expect(initialParameterValues(sourcePart(hexBoltComponent()), 'cfg_m5x40'))
      .toEqual({ length: '40', grade: '8.8' });
  });

  it('falls back to parameter defaults when no row is chosen', () => {
    expect(initialParameterValues(sourcePart(hexBoltComponent()), null))
      .toEqual({ length: '20', grade: '8.8' });
  });

  it('falls back to defaults when the row id does not exist', () => {
    // A stale id — the component was republished without that size. Showing
    // the defaults beats showing nothing.
    expect(initialParameterValues(sourcePart(hexBoltComponent()), 'cfg_gone'))
      .toEqual({ length: '20', grade: '8.8' });
  });
});

describe('overridesFrom', () => {
  it('keeps only values that differ from the configuration baseline', () => {
    // Pinning a value equal to the default would freeze it: a later version of
    // the component that changed that default would be ignored here, silently.
    expect(overridesFrom(sourcePart(hexBoltComponent()), 'cfg_m5x40', {
      length: '40', grade: '12.9',
    })).toEqual({ grade: '12.9' });
  });

  it('is empty when the user changed nothing', () => {
    const part = sourcePart(hexBoltComponent());
    expect(overridesFrom(part, 'cfg_m5x20', initialParameterValues(part, 'cfg_m5x20')))
      .toEqual({});
  });

  it('drops blank entries rather than storing an empty expression', () => {
    expect(overridesFrom(sourcePart(hexBoltComponent()), null, {
      length: '   ', grade: '10.9',
    })).toEqual({ grade: '10.9' });
  });

  it('ignores surrounding whitespace when deciding what changed', () => {
    expect(overridesFrom(sourcePart(hexBoltComponent()), null, {
      length: ' 20 ', grade: '8.8',
    })).toEqual({});
  });

  it('keeps an expression that references a host parameter', () => {
    // Overrides are expressions, not numbers — that is what keeps an inserted
    // component parametric instead of frozen at insert time.
    expect(overridesFrom(sourcePart(hexBoltComponent()), null, {
      length: 'plateThickness * 3', grade: '8.8',
    })).toEqual({ length: 'plateThickness * 3' });
  });
});

describe('isAllowedChoice', () => {
  it('rejects a value outside a choice parameter options', () => {
    const grade = publicParameters(sourcePart(hexBoltComponent()))
      .find(p => p.name === 'grade')!;
    expect(isAllowedChoice(grade, '10.9')).toBe(true);
    expect(isAllowedChoice(grade, '4.6')).toBe(false);
  });

  it('accepts anything for a numeric parameter', () => {
    // Numeric values are expressions; only the evaluator can judge them, and
    // it reports failures against the feature where they can be named.
    const length = publicParameters(sourcePart(hexBoltComponent()))
      .find(p => p.name === 'length')!;
    expect(isAllowedChoice(length, 'wallThickness * 2')).toBe(true);
  });
});
