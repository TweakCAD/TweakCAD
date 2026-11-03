/**
 * The component dialog's configuration chip, as hydrated from saved inputs.
 *
 * `configurationId` has three states, and the chip must show each one as the
 * builder will build it: a row id is that row, `null` is "(use defaults)",
 * and absent inherits the component's own active row. A saved `null` used to
 * show (and build) the active row, so choosing "(use defaults)" could not be
 * kept.
 */
import { describe, expect, it } from 'vitest';
import { createPart } from '@tweakcad/core/src/document/factory.ts';
import type { CadPart, ComponentFeatureInputs } from '@tweakcad/core/src/document/schema.ts';
import { DEFAULTS_ROW_ID, makeDraftFrom } from './ComponentDialog.tsx';

function partWithActive(active: string | null): CadPart {
  const part = createPart('Bolt');
  part.configurations = {
    active,
    rows: [
      { id: 'm3', name: 'M3', overrides: {} },
      { id: 'm5', name: 'M5', overrides: {} },
    ],
  };
  return part;
}

function inputs(configurationId?: string | null): ComponentFeatureInputs {
  return {
    componentRef: 'bolt',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    parameterOverrides: {},
    ...(configurationId !== undefined ? { configurationId } : {}),
    boolean: 'newBody',
  };
}

describe('ComponentDialog — configuration chip', () => {
  it('shows the picked row', () => {
    expect(makeDraftFrom(inputs('m5'), partWithActive('m3')).configRowId).toBe('m5');
  });

  it('shows "(use defaults)" for a saved null, even when the component has an active row', () => {
    expect(makeDraftFrom(inputs(null), partWithActive('m3')).configRowId).toBe(DEFAULTS_ROW_ID);
  });

  it('shows the inherited active row when nothing was picked', () => {
    expect(makeDraftFrom(inputs(), partWithActive('m3')).configRowId).toBe('m3');
  });

  it('shows "(use defaults)" when nothing was picked and the component has no active row', () => {
    expect(makeDraftFrom(inputs(), partWithActive(null)).configRowId).toBe(DEFAULTS_ROW_ID);
  });
});
