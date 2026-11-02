/**
 * Command handlers for project- and part-scoped parameter mutations.
 *
 * SetParameter is upsert: same command both creates a new entry and
 * updates an existing one. DeleteParameter removes by name. Both
 * validate against the resolved-parameter graph so a cycle introduced
 * by editing one row is caught at dispatch time, not at next rebuild.
 */

import type { Result } from '../../result.ts';
import { ok, err } from '../../result.ts';
import type { CadPart, CadProject, ParameterTable, ParameterValue } from '../../document/schema.ts';
import type { PartId } from '../../ids.ts';
import type { ParameterUnit } from '../../units.ts';
import { evaluateExpression, extractParameterRefs } from '../../expressions.ts';
import { resolveAllParameters } from '../../parameters/evaluator.ts';
import { sketchDimensionParameterRefs } from '../../sketch/derivedFields.ts';
import type { CadCommand } from '../types.ts';
import type { CommandHandler, ValidationError } from '../bus.ts';

const VALID_UNITS: ReadonlyArray<ParameterUnit> = ['mm', 'deg', 'count', 'none'];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function getScopeTable(
  state: Readonly<CadProject>,
  scope: 'project' | PartId,
): Result<Readonly<ParameterTable>, ValidationError> {
  if (scope === 'project') return ok(state.parameters);
  const part = state.parts[scope];
  if (!part) {
    return err({ code: 'NOT_FOUND', message: `Part not found for parameter scope: ${scope}` });
  }
  return ok(part.parameters);
}

function getMutableScopeTable(
  draft: CadProject,
  scope: 'project' | PartId,
): ParameterTable | null {
  if (scope === 'project') return draft.parameters;
  const part = draft.parts[scope];
  return part ? part.parameters : null;
}

export const setParameterHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SetParameter') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SetParameter command' });
    }

    const name = command.name.trim();
    if (!name) {
      return err({ code: 'INVALID_NAME', message: 'Parameter name cannot be empty', field: 'name' });
    }
    if (!NAME_RE.test(name)) {
      return err({
        code: 'INVALID_NAME',
        message: 'Parameter name must start with a letter or _, and contain only letters, digits, and _',
        field: 'name',
      });
    }
    if (name !== command.value.name) {
      return err({
        code: 'INVALID_NAME',
        message: 'Command-level name must match value.name',
        field: 'name',
      });
    }

    const value: ParameterValue = command.value;
    const kind = value.kind ?? 'number';

    if (typeof value.expression !== 'string') {
      return err({
        code: 'INVALID_EXPRESSION',
        message: 'Expression must be a string',
        field: 'expression',
      });
    }
    if (!VALID_UNITS.includes(value.unit)) {
      return err({
        code: 'INVALID_UNIT',
        message: `Unit must be one of: ${VALID_UNITS.join(', ')}`,
        field: 'unit',
      });
    }

    if (kind === 'choice') {
      // Choice-specific shape: options must exist & be unique; expression
      // must be one of the options (or empty placeholder if list is empty).
      if (!Array.isArray(value.options) || value.options.length === 0) {
        return err({
          code: 'INVALID_OPTIONS',
          message: 'Choice parameter must define at least one option',
          field: 'options',
        });
      }
      const seen = new Set<string>();
      for (const opt of value.options) {
        if (typeof opt !== 'string' || opt.trim() === '') {
          return err({
            code: 'INVALID_OPTIONS',
            message: 'Choice options must be non-empty strings',
            field: 'options',
          });
        }
        if (seen.has(opt)) {
          return err({
            code: 'INVALID_OPTIONS',
            message: `Duplicate option: "${opt}"`,
            field: 'options',
          });
        }
        seen.add(opt);
      }
      if (value.expression !== '' && !value.options.includes(value.expression)) {
        return err({
          code: 'INVALID_EXPRESSION',
          message: `Selected value "${value.expression}" is not in the options list`,
          field: 'expression',
        });
      }
    } else {
      // Number kind: expression must be non-empty; options must be absent.
      if (value.expression.trim() === '') {
        return err({
          code: 'INVALID_EXPRESSION',
          message: 'Expression cannot be empty',
          field: 'expression',
        });
      }
      if (value.options !== undefined) {
        return err({
          code: 'INVALID_OPTIONS',
          message: 'Options is only valid for choice-kind parameters',
          field: 'options',
        });
      }
    }

    const tableResult = getScopeTable(state, command.scope);
    if (!tableResult.ok) return tableResult;

    // Simulate the upsert and confirm the resulting parameter graph still
    // resolves without cycles. Reuses the same resolver the build pipeline
    // uses, so anything that would break a rebuild is caught here.
    // Also catches the case where a numeric expression references a choice
    // parameter (via the dedicated check in resolveAllParameters).
    const simulatedTable: ParameterTable = {
      values: { ...tableResult.value.values, [name]: value },
    };
    const projectSim = command.scope === 'project' ? simulatedTable : state.parameters;
    const partSim = command.scope === 'project' ? { values: {} } : simulatedTable;
    const resolveResult = resolveAllParameters(projectSim, partSim);
    if (!resolveResult.ok) {
      return err({
        code: 'INVALID_EXPRESSION',
        message: resolveResult.error,
        field: 'expression',
      });
    }

    // For number kind, do a standalone parse — catches purely syntactic
    // errors with a clearer message when the row has no dependencies (the
    // resolver already covered the dependency case above). Skipped for
    // choice since the value is not an expression.
    if (kind !== 'choice') {
      const parseResult = evaluateExpression(value.expression, resolveResult.value);
      if (!parseResult.ok) {
        return err({
          code: 'INVALID_EXPRESSION',
          message: parseResult.error,
          field: 'expression',
        });
      }
    }

    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SetParameter') return;
    const table = getMutableScopeTable(draft, command.scope);
    if (!table) return;
    table.values[command.name] = { ...command.value };
    draft.metadata.updatedAt = new Date().toISOString();
  },
};

/**
 * What would be left referencing `name` after it is deleted from `scope`,
 * as `"scope label: param"` / `"scope label: Sketch 1 (sketch dimension)"`
 * strings.
 *
 * Covers the parameter graph and sketch dimensions. A *feature* input
 * referencing the deleted name still fails, but it fails at that feature's
 * build with the feature named in its diagnostic — whereas an unresolvable
 * parameter table fails `resolveAllParameters` and blocks the whole part
 * with nothing pointing at the cause, and an unresolvable sketch dimension
 * fails nothing: the sketch keeps its last solved shape (with a warning), so
 * the parameter would quietly stop driving it.
 */
function findParameterDependents(
  state: Readonly<CadProject>,
  scope: 'project' | PartId,
  name: string,
): string[] {
  const dependents: string[] = [];
  const scan = (table: Readonly<ParameterTable>, label: string, skipSelf: boolean): void => {
    for (const [rowName, row] of Object.entries(table.values)) {
      if (skipSelf && rowName === name) continue;
      if (row.kind === 'choice') continue;
      if (extractParameterRefs(row.expression).has(name)) {
        dependents.push(`${label}${rowName}`);
      }
    }
  };
  const scanSketches = (part: Readonly<CadPart>, label: string): void => {
    for (const feature of part.timeline) {
      if (feature.type !== 'sketch') continue;
      const editorModel = (feature.inputs as { editorModel?: { constraints?: readonly unknown[] } }).editorModel;
      if (sketchDimensionParameterRefs(editorModel).has(name)) {
        dependents.push(`${label}${feature.name} (sketch dimension)`);
      }
    }
  };

  if (scope === 'project') {
    scan(state.parameters, '', true);
    for (const [partId, part] of Object.entries(state.parts)) {
      // A part that defines its own `name` shadows the project row, so
      // deleting the project row changes nothing it resolves against.
      if (part.parameters.values[name]) continue;
      scan(part.parameters, `${part.name || partId}: `, false);
      scanSketches(part, `${part.name || partId}: `);
    }
  } else {
    const part = state.parts[scope];
    // Deleting a part row that shadows a project row only un-shadows it —
    // every reference still resolves, against the project value.
    if (part && !state.parameters.values[name]) {
      scan(part.parameters, '', true);
      scanSketches(part, '');
    }
  }
  return dependents;
}

export const deleteParameterHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'DeleteParameter') {
      return err({ code: 'WRONG_TYPE', message: 'Expected DeleteParameter command' });
    }
    const tableResult = getScopeTable(state, command.scope);
    if (!tableResult.ok) return tableResult;
    if (!tableResult.value.values[command.name]) {
      return err({
        code: 'NOT_FOUND',
        message: `Parameter not found in scope: ${command.name}`,
        field: 'name',
      });
    }

    const dependents = findParameterDependents(state, command.scope, command.name);
    if (dependents.length > 0) {
      return err({
        code: 'HAS_DEPENDENTS',
        message:
          `Parameter "${command.name}" is referenced by ${dependents.join(', ')}. ` +
          'Update or delete those first.',
        field: 'name',
      });
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'DeleteParameter') return;
    const table = getMutableScopeTable(draft, command.scope);
    if (!table) return;
    // Deleting on the draft keeps the undo patch a single-key remove;
    // rebuilding `values` would record a whole-table replace.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- name-keyed record
    delete table.values[command.name];
    draft.metadata.updatedAt = new Date().toISOString();
  },
};
