/**
 * Parameter evaluation and dependency resolution.
 * Resolves expression strings to numeric values using project and part parameters.
 */

import type { ParameterTable } from '../document/schema.ts';
import type { Result } from '../result.ts';
import { ok, err } from '../result.ts';
import { evaluateExpression, extractParameterRefs } from '../expressions.ts';
import type { ResolvedParams } from '../expressions.ts';

/**
 * Resolve all parameters from project and part parameter tables.
 * Handles parameter precedence: part params override project params.
 * Detects circular dependencies.
 *
 * @param projectParams - Project-level parameter table
 * @param partParams - Part-level parameter table (overrides project)
 * @returns Resolved name-to-value map, or error message
 */
export function resolveAllParameters(
  projectParams: ParameterTable,
  partParams: ParameterTable,
): Result<ResolvedParams, string> {
  // Merge tables (part overrides project)
  const allParams = { ...projectParams.values, ...partParams.values };

  // Choice parameters are string-typed: they don't enter the numeric resolved
  // map. We collect them separately so we can produce a clear "choice X
  // cannot be used in a numeric expression" error when a numeric expression
  // references one.
  const choiceNames = new Set<string>();
  for (const [name, param] of Object.entries(allParams)) {
    if (param.kind === 'choice') choiceNames.add(name);
  }

  // Build dependency graph (numeric params only; choice params are leaves
  // from the resolver's perspective).
  const dependencies = new Map<string, Set<string>>();
  for (const [name, param] of Object.entries(allParams)) {
    if (param.kind === 'choice') continue;
    const refs = extractParameterRefs(param.expression);
    // Detect references to choice params and reject with a specific message
    // so the user sees the real problem rather than "Unknown parameter".
    for (const ref of refs) {
      if (choiceNames.has(ref)) {
        return err(
          `Parameter "${name}" references choice parameter "${ref}"; choice parameters cannot be used in numeric expressions`,
        );
      }
    }
    dependencies.set(name, refs);
  }

  // Topological sort for evaluation order
  const sortResult = topologicalSort(dependencies);
  if (!sortResult.ok) return sortResult;

  // Evaluate in dependency order
  const resolved: ResolvedParams = {};
  for (const name of sortResult.value) {
    const param = allParams[name];
    if (!param || param.kind === 'choice') continue;

    const result = evaluateExpression(param.expression, resolved);
    if (!result.ok) {
      return err(`Failed to resolve parameter "${name}": ${result.error}`);
    }
    resolved[name] = result.value;
  }

  return ok(resolved);
}

/**
 * Topological sort of parameter dependencies.
 * Detects circular dependencies.
 *
 * @param deps - Map of parameter name to its dependencies
 * @returns Sorted list of parameter names, or error if circular
 */
function topologicalSort(deps: Map<string, Set<string>>): Result<string[], string> {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string): Result<void, string> {
    if (visited.has(name)) return ok(undefined);
    if (visiting.has(name)) {
      return err(`Circular dependency detected involving parameter "${name}"`);
    }

    visiting.add(name);
    const nodeDeps = deps.get(name);
    if (nodeDeps) {
      for (const dep of nodeDeps) {
        if (deps.has(dep)) {
          const result = visit(dep);
          if (!result.ok) return result;
        }
      }
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
    return ok(undefined);
  }

  for (const name of deps.keys()) {
    const result = visit(name);
    if (!result.ok) return result;
  }

  return ok(sorted);
}
