/**
 * Small typed readers for the parameters bag that a `ComponentInstance`
 * feature stores. Keeps the per-component builders free of parse boilerplate.
 *
 * The parameters bag is `Record<string, unknown>` because:
 *   - it's persisted in `.cadjson` and can survive a schema rename
 *   - components in the SaaS catalog may add new parameters between bumps
 *
 * Callers pass candidate names in priority order — the first one with a
 * usable value wins, then we fall back to the standards table.
 */

/**
 * Read the first parameter whose value is a finite number (or a parseable
 * numeric string). Returns `undefined` when none of the candidates resolve.
 */
export function readNumberParameter(
  params: Record<string, unknown>,
  ...names: string[]
): number | undefined {
  for (const name of names) {
    const raw = params[name];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Read the first parameter whose value is a non-empty string. Used for
 * enum-style fields like `thread: 'M5'`.
 */
export function readEnumParameter(
  params: Record<string, unknown>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const raw = params[name];
    if (typeof raw === 'string' && raw.length > 0) return raw;
  }
  return undefined;
}
