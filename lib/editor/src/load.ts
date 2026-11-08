import { isPlainObject, parseStrictJson, readDocument, writeDocument, type Diagnostic } from '@tweakcad/format';
import type { Doc } from './rows';

export type LoadResult =
  | {
      ok: true;
      document: Doc;
      /** Content that pauses what depends on it, and ignored presentational content. */
      warnings: readonly Diagnostic[];
    }
  | {
      ok: false;
      /** A plain sentence for the user. */
      message: string;
      diagnostics: readonly Diagnostic[];
    };

/** The message for a version-1 document, which this reader does not open. */
export const VERSION_1_MESSAGE =
  'This document is in the old format (version 1), which this version of TweakCAD does not open. It has to be converted first.';

/**
 * Reads a `.cadjson` text: strict JSON, then the format reader. Refusals
 * refuse the load; pauses and ignored content come back as warnings. A
 * version-1 document is refused with a plain message.
 */
export function loadDocument(text: string): LoadResult {
  let parsed;
  try {
    parsed = parseStrictJson(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: `This file is not a readable document: ${message}`,
      diagnostics: [{ severity: 'refuse', code: 'wrong-type', path: '', message }],
    };
  }
  if (isPlainObject(parsed.value) && parsed.value.schemaVersion === 1) {
    return {
      ok: false,
      message: VERSION_1_MESSAGE,
      diagnostics: [
        { severity: 'refuse', code: 'unknown-version', path: '/schemaVersion', message: VERSION_1_MESSAGE },
      ],
    };
  }
  const result = readDocument(parsed.value, parsed.decoratedIntegers);
  const refusals = result.diagnostics.filter((d) => d.severity === 'refuse');
  if (result.refused || !result.document) {
    const first = refusals[0];
    return {
      ok: false,
      message: first
        ? `This document cannot be opened: ${first.message} (at ${first.path || '/'})`
        : 'This document cannot be opened.',
      diagnostics: refusals,
    };
  }
  return { ok: true, document: result.document, warnings: result.diagnostics };
}

/** Writes a document in canonical form (RFC 8785, chapter 2). */
export function saveDocument(document: Doc): string {
  return writeDocument(document);
}
