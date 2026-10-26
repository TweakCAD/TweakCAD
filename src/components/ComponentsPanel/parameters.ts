/**
 * Pure helpers for the configure-view parameter form.
 *
 * The knobs come from the component's **own document** — the `public`
 * parameters and the configuration rows of its single part — not from a
 * separate catalog manifest. The `.cadjson` is the manifest: a component is
 * just a project, and its parameter table already says what is adjustable,
 * what unit it is in and what it means. A parallel manifest would be a second
 * copy of that, free to drift from the geometry it claims to describe.
 *
 * Kept apart from the React component so defaults, coercion and the
 * configuration merge are testable without rendering.
 */

import type {
  CadProject,
  CadPart,
  ConfigurationRow,
  ParameterValue,
} from '@tweakcad/core/src/document/schema.ts';

/** A component's single part. Components are one-part projects by definition. */
export function componentPart(source: CadProject): CadPart | null {
  const parts = Object.values(source.parts ?? {});
  return parts[0] ?? null;
}

/**
 * The parameters a consumer is meant to touch, in declaration order.
 *
 * `public: true` is the author's opt-in. A component with none published is
 * not broken — it is simply non-adjustable, and the panel says so rather than
 * showing every internal helper parameter.
 */
export function publicParameters(part: CadPart): ParameterValue[] {
  return Object.values(part.parameters?.values ?? {}).filter(p => p.public === true);
}

/** Named presets, if the author defined any. */
export function configurationRows(part: CadPart): ConfigurationRow[] {
  return part.configurations?.rows ?? [];
}

/**
 * Starting expression for each public parameter under a chosen configuration.
 *
 * Merge order matches the rebuilder's: parameter default, then the active
 * configuration row's override. Per-instance overrides are what this form
 * produces, so they are the layer above and not applied here.
 */
export function initialParameterValues(
  part: CadPart,
  configurationId: string | null,
): Record<string, string> {
  const row = configurationId
    ? configurationRows(part).find(r => r.id === configurationId)
    : undefined;
  const out: Record<string, string> = {};
  for (const param of publicParameters(part)) {
    out[param.name] = String(row?.overrides?.[param.name] ?? param.expression);
  }
  return out;
}

/**
 * Narrow the form's values to the ones that actually differ from what the
 * component would do on its own.
 *
 * Storing an override equal to the default would pin the value: a later
 * component update that changes that default would be silently ignored on
 * this instance. Only real edits are kept.
 */
export function overridesFrom(
  part: CadPart,
  configurationId: string | null,
  values: Record<string, string>,
): Record<string, string> {
  const baseline = initialParameterValues(part, configurationId);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === String(baseline[name] ?? '').trim()) continue;
    out[name] = trimmed;
  }
  return out;
}

/**
 * Whether a choice parameter would accept `value`.
 *
 * Numeric parameters are not validated here: they hold expressions, which may
 * reference other parameters and can only be judged by the evaluator. The
 * rebuild reports a bad one against the feature, where the error can name it.
 */
export function isAllowedChoice(param: ParameterValue, value: string): boolean {
  if (param.kind !== 'choice') return true;
  return (param.options ?? []).includes(value);
}
