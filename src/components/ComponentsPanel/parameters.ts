/**
 * Pure helpers for the configure-view parameter form.
 *
 * Kept separate from the React component so the logic (defaults,
 * clamping, type coercion) is testable without DOM rendering — matches
 * the existing test style in this repo (sketchSolver.test.ts).
 */

import type { ComponentManifest, ComponentParameter } from '@tweakcad/api-types';

/**
 * Build the initial parameter value map for a manifest.
 *
 * Falls back to a type-sensible default when the manifest's `default` is
 * missing or ill-typed, so the configure view always renders something a
 * user can edit.
 */
export function initialParameterValues(
  manifest: ComponentManifest,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const param of manifest.parameters) {
    out[param.name] = resolveDefault(param);
  }
  return out;
}

function resolveDefault(param: ComponentParameter): unknown {
  switch (param.type) {
    case 'number': {
      if (typeof param.default === 'number' && Number.isFinite(param.default)) {
        return clampNumber(param.default, param.range);
      }
      if (param.range) return param.range[0];
      return 0;
    }
    case 'enum': {
      if (typeof param.default === 'string' && param.values?.includes(param.default)) {
        return param.default;
      }
      return param.values?.[0] ?? '';
    }
    case 'boolean':
      return typeof param.default === 'boolean' ? param.default : false;
    case 'string':
      return typeof param.default === 'string' ? param.default : '';
  }
}

/** Clamp a number to the parameter's optional [min, max] range. */
export function clampNumber(
  value: number,
  range: readonly [number, number] | undefined,
): number {
  if (!range) return value;
  const [min, max] = range;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Coerce a raw form value (string from <input>, etc.) into the manifest's
 * declared type. Returns `null` when the input can't be coerced — the
 * caller can fall back to the previous value rather than store garbage.
 */
export function coerceParameterValue(
  param: ComponentParameter,
  raw: unknown,
): unknown {
  switch (param.type) {
    case 'number': {
      const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
      if (!Number.isFinite(num)) return null;
      return clampNumber(num, param.range);
    }
    case 'enum': {
      const str = String(raw);
      return param.values?.includes(str) ? str : null;
    }
    case 'boolean':
      return Boolean(raw);
    case 'string':
      return String(raw);
  }
}
