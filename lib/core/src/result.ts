/**
 * Discriminated union Result type for expected failures.
 * Core packages return Result<T, E> instead of throwing.
 * Only React components and top-level handlers may throw.
 */

export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Create a successful result.
 * @param value - The success value
 * @returns A Result with ok: true
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Create a failure result.
 * @param error - The error value
 * @returns A Result with ok: false
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Unwrap a Result, throwing on error.
 * Only for use in top-level handlers, never in core packages.
 * @param result - The Result to unwrap
 * @returns The success value
 * @throws The error value if the result is not ok
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error;
}

/**
 * Map the success value of a Result.
 * @param result - The Result to map
 * @param fn - Transform function for the success value
 * @returns A new Result with the mapped value
 */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (result.ok) return ok(fn(result.value));
  return result;
}

/**
 * Map the error value of a Result.
 * @param result - The Result to map
 * @param fn - Transform function for the error value
 * @returns A new Result with the mapped error
 */
export function mapError<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  if (!result.ok) return err(fn(result.error));
  return result;
}
