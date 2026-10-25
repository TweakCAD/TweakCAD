/**
 * Document format version, and the migration chain that carries older files
 * forward.
 *
 * One constant, read by every writer — the factory, the FCStd converter, and
 * the SaaS publish manifest. Before this existed those three disagreed: two
 * wrote `'0.1'`, one wrote `'0.2'`, the publish manifest hardcoded `'0.1'`
 * regardless of what it was describing, and nothing anywhere branched on the
 * value. A version nobody writes consistently and nobody reads is decoration.
 *
 * ## Why an integer
 *
 * `'0.1'` / `'0.2'` looked like semver and wasn't: there was no rule for what
 * a minor bump meant, and string comparison orders `'0.10'` before `'0.2'`.
 * A monotonically increasing integer has exactly one meaning — "the Nth shape
 * this format has had" — and compares correctly forever.
 *
 * ## The compatibility contract
 *
 * - `doc.schemaVersion < CURRENT` — run the migration chain, then load.
 * - `doc.schemaVersion === CURRENT` — load.
 * - `doc.schemaVersion > CURRENT` — **refuse.** A newer writer may have used
 *   a field shape this build cannot represent, and loading it anyway risks
 *   writing back a lossy version. Tell the user to update instead.
 *
 * Unknown *keys* are a different question and are preserved rather than
 * refused — see `loadCadDocument`.
 */

import type { Result } from '../result.ts';
import { ok, err } from '../result.ts';

/**
 * The version this build writes. Bump by one whenever a change to the
 * persisted shape cannot be read correctly by the previous loader, and add
 * the matching migration below in the same commit.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * One step of the chain. Takes a raw, *unvalidated* document object at
 * `from` and returns one at `to`. Migrations run before schema validation —
 * the whole point is that the input does not satisfy the current schema yet —
 * so they must be defensive about shape and never assume a field is present.
 */
export type Migration = {
  readonly from: number;
  readonly to: number;
  readonly describe: string;
  migrate(doc: Record<string, unknown>): Record<string, unknown>;
};

/**
 * The chain, ordered by `from`. Empty at version 1: there is no earlier
 * released format to migrate from, since the `'0.1'`/`'0.2'` strings never
 * shipped to a user.
 *
 * This array is deliberately present-and-empty rather than absent. The
 * convention — where migrations live, what shape they take, that they run
 * before validation — is cheaper to establish now than to invent under
 * pressure the first time the format moves.
 */
export const MIGRATIONS: readonly Migration[] = [];

/**
 * Walk a raw document from its declared version up to {@link CURRENT_SCHEMA_VERSION}.
 *
 * @param doc Raw parsed JSON, not yet validated.
 * @param from The document's declared `schemaVersion`.
 * @returns The migrated document, or an error naming the missing step.
 */
export function migrateToCurrent(
  doc: Record<string, unknown>,
  from: number,
): Result<Record<string, unknown>, string> {
  if (from > CURRENT_SCHEMA_VERSION) {
    return err(
      `Document is version ${from}; this build understands up to ` +
        `${CURRENT_SCHEMA_VERSION}. Update TweakCAD to open it.`,
    );
  }

  let current = doc;
  let version = from;
  // Guard against a malformed chain looping forever: each step must advance.
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS.find(m => m.from === version);
    if (!step) {
      return err(
        `No migration from document version ${version} to ` +
          `${version + 1}; cannot open this file.`,
      );
    }
    if (step.to <= version) {
      return err(`Migration "${step.describe}" does not advance the version.`);
    }
    current = step.migrate(current);
    version = step.to;
  }

  return ok(current);
}
