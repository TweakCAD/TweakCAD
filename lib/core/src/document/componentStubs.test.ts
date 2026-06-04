/**
 * Validates that hand-authored .cadjson component stubs in /components
 * conform to CadProjectSchema. These are stand-alone "future component"
 * fixtures — see components/README.md.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CadProjectSchema } from './validation.ts';

const COMPONENTS_DIR = resolve(__dirname, '../../../../../components');

function listStubs(): string[] {
  try {
    return readdirSync(COMPONENTS_DIR).filter(f => f.endsWith('.cadjson'));
  } catch {
    return [];
  }
}

describe('component stub .cadjson files', () => {
  const stubs = listStubs();

  it('finds at least one stub file', () => {
    expect(stubs.length).toBeGreaterThan(0);
  });

  for (const file of stubs) {
    it(`${file} validates against CadProjectSchema`, () => {
      const text = readFileSync(resolve(COMPONENTS_DIR, file), 'utf8');
      const json = JSON.parse(text);
      const result = CadProjectSchema.safeParse(json);
      if (!result.success) {
        const issues = result.error.issues.slice(0, 5)
          .map(i => `  ${i.path.join('.')}: ${i.message}`)
          .join('\n');
        throw new Error(`${file} failed validation:\n${issues}`);
      }
      expect(result.success).toBe(true);
    });
  }
});
