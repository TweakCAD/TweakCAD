/**
 * Serialization utilities for .cadjson files.
 * Handles reading and writing of project documents.
 */

import type { CadProject } from './schema.ts';

// Reading lives in `./loader.ts` (`loadCadDocument`). A `parseCadJson` used
// to sit here — the only validating parser in the repo, and imported by
// nothing, because `diskAdapter.ts` declared a weaker local function with the
// same name that shadowed it at every call site. The collision is why it went
// unnoticed; removing it means the mistake cannot be made again.

/**
 * Serialize a CadProject to a .cadjson string.
 * @param project - The project to serialize
 * @param pretty - Whether to format with indentation
 * @returns JSON string
 */
export function serializeCadJson(project: CadProject, pretty = true): string {
  return JSON.stringify(project, null, pretty ? 2 : undefined);
}

/**
 * Trigger a browser download of a .cadjson file.
 * @param project - The project to download
 * @param filename - Suggested filename
 */
export function downloadCadJson(project: CadProject, filename: string): void {
  const json = serializeCadJson(project);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.cadjson') ? filename : `${filename}.cadjson`;
  a.click();
  URL.revokeObjectURL(url);
}
