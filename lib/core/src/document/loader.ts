/**
 * The one way a `.cadjson` enters the application.
 *
 * Every entry point goes through here — disk open, cloud load, IndexedDB
 * restore, component import, and server-side validation at publish. Before
 * this existed each of those did something different: the disk path checked
 * three magic keys and cast, the cloud path was a bare `as CadProject`, and
 * the only validating parser in the repo was dead code shadowed by a weaker
 * local function with the same name. Published gallery documents were
 * accepted unvalidated.
 *
 * ## What is fatal and what degrades
 *
 * Fatal — nothing useful can be recovered, so the load fails:
 *   - not JSON, or not an object
 *   - `schemaVersion` missing, non-numeric, or newer than this build
 *     (see `./version.ts` for why newer is refused rather than attempted)
 *   - no migration path from an older version
 *   - the envelope is wrong: no `parts`, broken `metadata`, malformed
 *     parameter table
 *
 * Degraded — the document loads and the problem is reported per feature:
 *   - a `type` this build does not know (newer client, or a plugin)
 *   - a known type whose `inputs` fail validation
 *
 * The asymmetry is deliberate. A feature is one entry in a timeline; losing
 * the whole document because one of them is unreadable costs the user
 * everything else they drew. The rebuild pipeline already renders a failed
 * feature as failed, so a degraded document behaves like one with a broken
 * feature — which is exactly what it is.
 *
 * ## Unknown keys survive
 *
 * Zod strips unknown keys by default. If this loader returned Zod's output,
 * an older build opening a newer document would silently drop every field it
 * did not recognise and write the truncated version back on the next save —
 * data loss introduced *by* adding validation. So validation runs against the
 * parsed object and the **original** object is what gets returned. Zod is
 * asked whether the document is valid, never what it should become.
 *
 * The single exception is `FeatureNode.visible`, which has a schema default;
 * the loader applies it explicitly below.
 */

import type { Result } from '../result.ts';
import { ok, err } from '../result.ts';
import type { CadProject } from './schema.ts';
import { CadProjectEnvelopeSchema, FeatureNodeSchema, FeatureTypeSchema } from './validation.ts';
import { CURRENT_SCHEMA_VERSION, migrateToCurrent } from './version.ts';

/** A per-feature problem that did not stop the document loading. */
export type LoadDiagnostic = {
  code: 'unsupported-feature' | 'invalid-feature-inputs';
  partId: string;
  featureId: string;
  featureType: string;
  message: string;
};

export type LoadedDocument = {
  project: CadProject;
  /** Empty when the document loaded cleanly. */
  diagnostics: LoadDiagnostic[];
};

export type LoadErrorCode =
  | 'invalid-json'
  | 'not-a-document'
  | 'unsupported-version'
  | 'migration-failed'
  | 'invalid-envelope';

export type LoadError = {
  code: LoadErrorCode;
  /** Shown to the user. Complete sentence, no trailing context. */
  message: string;
  /** Zod paths, when the envelope was the problem. Capped — a wrong file type
   *  produces hundreds and none of them help. */
  issues?: string[];
};

const MAX_REPORTED_ISSUES = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse and validate a document.
 *
 * @param input Raw JSON text, or an already-parsed object (IndexedDB and the
 *   cloud adapter both hand over objects; only disk has a string).
 */
export function loadCadDocument(input: unknown): Result<LoadedDocument, LoadError> {
  // ---- 1. Parse ----
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (e) {
      return err({
        code: 'invalid-json',
        message: `This file isn't valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  if (!isPlainObject(parsed)) {
    return err({ code: 'not-a-document', message: "This file isn't a TweakCAD document." });
  }

  // ---- 2. Version gate, before anything else reads a field ----
  const rawVersion = parsed.schemaVersion;
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 1) {
    return err({
      code: 'not-a-document',
      message:
        'This file has no usable schemaVersion, so it is either not a TweakCAD ' +
        'document or was written before the format was versioned.',
    });
  }
  if (rawVersion > CURRENT_SCHEMA_VERSION) {
    return err({
      code: 'unsupported-version',
      message:
        `This document was saved by a newer version of TweakCAD ` +
        `(format ${rawVersion}; this build reads up to ${CURRENT_SCHEMA_VERSION}). ` +
        `Update TweakCAD to open it.`,
    });
  }

  // ---- 3. Migrate forward ----
  const migrated = migrateToCurrent(parsed, rawVersion);
  if (!migrated.ok) {
    return err({ code: 'migration-failed', message: migrated.error });
  }
  const doc = migrated.value;

  // ---- 4. Envelope ----
  // Timelines are `unknown` here on purpose; step 5 handles them per feature.
  const envelope = CadProjectEnvelopeSchema.safeParse(doc);
  if (!envelope.success) {
    return err({
      code: 'invalid-envelope',
      message: "This document's structure is not readable.",
      issues: envelope.error.issues
        .slice(0, MAX_REPORTED_ISSUES)
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
  }

  // ---- 5. Features, one at a time ----
  const diagnostics: LoadDiagnostic[] = [];
  const parts = doc.parts as Record<string, Record<string, unknown>>;

  for (const [partId, part] of Object.entries(parts)) {
    const timeline = part.timeline;
    if (!Array.isArray(timeline)) continue; // envelope already guaranteed an array

    for (const node of timeline as unknown[]) {
      if (!isPlainObject(node)) {
        diagnostics.push({
          code: 'invalid-feature-inputs',
          partId,
          featureId: '(unknown)',
          featureType: '(unknown)',
          message: 'Timeline entry is not an object and will be skipped.',
        });
        continue;
      }

      const featureId = typeof node.id === 'string' ? node.id : '(unknown)';
      const featureType = typeof node.type === 'string' ? node.type : '(unknown)';

      // Apply the one schema default by hand — see the module docstring on
      // why Zod's output is not used.
      if (node.visible === undefined) node.visible = true;

      if (!FeatureTypeSchema.safeParse(featureType).success) {
        diagnostics.push({
          code: 'unsupported-feature',
          partId,
          featureId,
          featureType,
          message:
            `Feature type "${featureType}" is not supported by this build. ` +
            `It has been kept, but will not rebuild.`,
        });
        continue;
      }

      const check = FeatureNodeSchema.safeParse(node);
      if (!check.success) {
        diagnostics.push({
          code: 'invalid-feature-inputs',
          partId,
          featureId,
          featureType,
          message:
            `Feature "${featureId}" (${featureType}) has unreadable inputs and ` +
            `will not rebuild: ` +
            check.error.issues
              .slice(0, 3)
              .map(i => `${i.path.join('.')} ${i.message}`)
              .join('; '),
        });
      }
    }
  }

  // The ORIGINAL object, unknown keys and all — never Zod's stripped copy.
  return ok({ project: doc as unknown as CadProject, diagnostics });
}

/**
 * Convenience wrapper for callers that only care whether it loaded and will
 * surface diagnostics themselves. Keeps the common call site to one line.
 */
export function loadCadDocumentOrThrow(input: unknown): LoadedDocument {
  const result = loadCadDocument(input);
  if (!result.ok) {
    const detail = result.error.issues?.length
      ? `\n${result.error.issues.join('\n')}`
      : '';
    throw new Error(`${result.error.message}${detail}`);
  }
  return result.value;
}

/** Re-exported so callers do not need a second import to compare versions. */
export { CURRENT_SCHEMA_VERSION };
