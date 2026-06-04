/**
 * Command handlers for per-part configuration tables.
 *
 * A configuration is a named row of parameter overrides. When a row is
 * active, the rebuilder merges its overrides on top of the part's
 * parameter table before resolving expressions (see rebuilder.ts).
 *
 * Validation runs the same way as parameters: simulate the upsert, then
 * try to resolve the parameter graph with the overrides applied, so cycle
 * and unknown-name errors are caught at dispatch time, not at next build.
 */

import type { Result } from '../../result.ts';
import { ok, err } from '../../result.ts';
import type {
  CadProject,
  CadPart,
  ConfigurationRow,
  ParameterTable,
  ParameterValue,
} from '../../document/schema.ts';
import type { PartId } from '../../ids.ts';
import { evaluateExpression } from '../../expressions.ts';
import { resolveAllParameters } from '../../parameters/evaluator.ts';
import type { CadCommand } from '../types.ts';
import type { CommandHandler, ValidationError } from '../bus.ts';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function getPart(state: Readonly<CadProject>, partId: PartId): Result<Readonly<CadPart>, ValidationError> {
  const part = state.parts[partId];
  if (!part) return err({ code: 'NOT_FOUND', message: `Part not found: ${partId}` });
  return ok(part);
}

function getMutablePart(draft: CadProject, partId: PartId): CadPart | null {
  return draft.parts[partId] ?? null;
}

/**
 * Build the effective parameter table for a part when a given config row's
 * overrides are applied. Used both at validation time (to catch cycles) and
 * at rebuild time (rebuilder calls a similar merge inline).
 *
 * The overrides REPLACE the parameter's expression, keeping the existing
 * unit/public/kind/options fields intact. This means a config row can
 * change the value of a numeric param but cannot turn a number param into
 * a choice param (which would be confusing anyway).
 */
function applyOverrides(
  table: Readonly<ParameterTable>,
  overrides: Record<string, string>,
): ParameterTable {
  const next: Record<string, ParameterValue> = {};
  for (const [name, param] of Object.entries(table.values)) {
    const override = overrides[name];
    if (override !== undefined) {
      next[name] = { ...param, expression: override };
    } else {
      next[name] = param;
    }
  }
  return { values: next };
}

export const setConfigurationRowHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SetConfigurationRow') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SetConfigurationRow command' });
    }

    const partResult = getPart(state, command.partId);
    if (!partResult.ok) return partResult;
    const part = partResult.value;

    const row: ConfigurationRow = command.row;
    if (!row.id || !row.id.trim()) {
      return err({ code: 'INVALID_ID', message: 'Configuration row id cannot be empty', field: 'id' });
    }
    if (!row.name || !row.name.trim()) {
      return err({ code: 'INVALID_NAME', message: 'Configuration row name cannot be empty', field: 'name' });
    }

    // Validate each override:
    //   - the override expression must be a non-empty string
    //   - the name must reference an existing PART-scope parameter
    //     (overrides on project-scope params are silently dropped by the
    //     merge helper because configurations are per-part; reject loudly
    //     here so the author shadows the project param into the part scope
    //     first instead of getting a silent no-op)
    //   - the parameter must be number-kind (choice overrides not supported in v1)
    for (const [overrideName, overrideExpr] of Object.entries(row.overrides)) {
      if (!NAME_RE.test(overrideName)) {
        return err({
          code: 'INVALID_NAME',
          message: `Override name "${overrideName}" is not a valid parameter identifier`,
          field: 'overrides',
        });
      }
      const partParam = part.parameters.values[overrideName];
      if (!partParam) {
        const isProjectOnly = state.parameters.values[overrideName] !== undefined;
        return err({
          code: isProjectOnly ? 'INVALID_OVERRIDE' : 'UNKNOWN_PARAMETER',
          message: isProjectOnly
            ? `Cannot override project-scope parameter "${overrideName}" — configurations override part-scope params only. Shadow it in the part scope first.`
            : `Override references unknown parameter "${overrideName}"`,
          field: 'overrides',
        });
      }
      if (partParam.kind === 'choice') {
        return err({
          code: 'INVALID_OVERRIDE',
          message: `Cannot override choice parameter "${overrideName}" — choice params change via active row, not overrides`,
          field: 'overrides',
        });
      }
      if (typeof overrideExpr !== 'string' || overrideExpr.trim() === '') {
        return err({
          code: 'INVALID_EXPRESSION',
          message: `Override expression for "${overrideName}" cannot be empty`,
          field: 'overrides',
        });
      }
    }

    // Simulate the upsert against an effective parameter table and confirm
    // it resolves cleanly. Catches cycles introduced by the override (e.g.
    // overriding `width` to `length / 2` when `length = width * 2 + 5`).
    const effectivePartParams = applyOverrides(part.parameters, row.overrides);
    const resolveResult = resolveAllParameters(state.parameters, effectivePartParams);
    if (!resolveResult.ok) {
      return err({
        code: 'INVALID_EXPRESSION',
        message: resolveResult.error,
        field: 'overrides',
      });
    }
    for (const [overrideName, overrideExpr] of Object.entries(row.overrides)) {
      const parseCheck = evaluateExpression(overrideExpr, resolveResult.value);
      if (!parseCheck.ok) {
        return err({
          code: 'INVALID_EXPRESSION',
          message: `Override "${overrideName}": ${parseCheck.error}`,
          field: 'overrides',
        });
      }
    }

    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SetConfigurationRow') return;
    const part = getMutablePart(draft, command.partId);
    if (!part) return;
    if (!part.configurations) {
      part.configurations = { active: null, rows: [] };
    }
    const table = part.configurations;
    const idx = table.rows.findIndex(r => r.id === command.row.id);
    const fresh: ConfigurationRow = {
      id: command.row.id,
      name: command.row.name,
      overrides: { ...command.row.overrides },
    };
    if (idx < 0) {
      table.rows.push(fresh);
    } else {
      table.rows[idx] = fresh;
    }
    draft.metadata.updatedAt = new Date().toISOString();
  },
};

export const deleteConfigurationRowHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'DeleteConfigurationRow') {
      return err({ code: 'WRONG_TYPE', message: 'Expected DeleteConfigurationRow command' });
    }
    const partResult = getPart(state, command.partId);
    if (!partResult.ok) return partResult;
    const part = partResult.value;
    const table = part.configurations;
    if (!table) {
      return err({ code: 'NOT_FOUND', message: 'Part has no configurations table' });
    }
    if (!table.rows.some(r => r.id === command.rowId)) {
      return err({ code: 'NOT_FOUND', message: `Configuration row not found: ${command.rowId}` });
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'DeleteConfigurationRow') return;
    const part = getMutablePart(draft, command.partId);
    if (!part?.configurations) return;
    part.configurations.rows = part.configurations.rows.filter(r => r.id !== command.rowId);
    // If the deleted row was active, clear active so the next rebuild
    // doesn't try to look it up.
    if (part.configurations.active === command.rowId) {
      part.configurations.active = null;
    }
    draft.metadata.updatedAt = new Date().toISOString();
  },
};

export const setActiveConfigurationHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SetActiveConfiguration') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SetActiveConfiguration command' });
    }
    const partResult = getPart(state, command.partId);
    if (!partResult.ok) return partResult;
    if (command.rowId === null) return ok(undefined);
    const table = partResult.value.configurations;
    if (!table || !table.rows.some(r => r.id === command.rowId)) {
      return err({ code: 'NOT_FOUND', message: `Configuration row not found: ${command.rowId}` });
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SetActiveConfiguration') return;
    const part = getMutablePart(draft, command.partId);
    if (!part) return;
    if (!part.configurations) {
      // Activating null on a part with no configs is a no-op but well-defined.
      if (command.rowId === null) return;
      part.configurations = { active: null, rows: [] };
    }
    part.configurations.active = command.rowId;
    draft.metadata.updatedAt = new Date().toISOString();
  },
};

/**
 * Compute the effective part parameter table by overlaying the active
 * configuration row's overrides. Used by the rebuilder; also re-used by
 * the editor's "= Resolved" preview when a config is active.
 *
 * Exported so the rebuilder can call it without duplicating the merge
 * semantics. The function is null-safe: parts without configurations or
 * without an active row return their parameter table unchanged.
 */
export function applyActiveConfiguration(part: Readonly<CadPart>): ParameterTable {
  const table = part.configurations;
  if (!table || table.active === null) return part.parameters;
  const row = table.rows.find(r => r.id === table.active);
  if (!row) return part.parameters;
  return applyOverrides(part.parameters, row.overrides);
}
