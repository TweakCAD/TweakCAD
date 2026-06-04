/**
 * Serialization utilities for .cadjson files.
 * Handles reading and writing of project documents.
 */

import type { Result } from '../result.ts';
import { ok, err } from '../result.ts';
import type { CadProject } from './schema.ts';
import { CadProjectSchema } from './validation.ts';

/**
 * Parse a .cadjson string into a CadProject.
 * @param json - Raw JSON string
 * @returns Validated CadProject or error
 */
export function parseCadJson(json: string): Result<CadProject, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return err(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = CadProjectSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    return err(`Validation failed:\n${issues.join('\n')}`);
  }

  return ok(result.data as CadProject);
}

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
