import { describe, expect, it } from 'vitest';
import { CAD_TOOLS, CAD_TOOLS_CONTRACT, findTool, isToolName } from './index.ts';

/** Every schema object under a tool's input, with its path. */
function schemas(value: unknown, path: string, out: { path: string; schema: Record<string, unknown> }[] = []) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  const schema = value as Record<string, unknown>;
  out.push({ path, schema });
  for (const [name, inner] of Object.entries((schema.properties as Record<string, unknown> | undefined) ?? {}))
    schemas(inner, `${path}.${name}`, out);
  if (schema.items) schemas(schema.items, `${path}[]`, out);
  return out;
}

describe('the tool catalogue', () => {
  it('is version 3 of the contract', () => {
    expect(CAD_TOOLS_CONTRACT).toBe(3);
  });

  it('has unique names MCP accepts', () => {
    const names = CAD_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(isToolName('feature_extrude')).toBe(true);
    expect(findTool('get_document')?.name).toBe('get_document');
    expect(findTool('dispatch_command')).toBeUndefined();
  });

  it('gives every tool an object schema whose required fields are its properties', () => {
    for (const t of CAD_TOOLS) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
      const properties = Object.keys(t.inputSchema.properties ?? {});
      for (const r of t.inputSchema.required ?? []) expect(properties, `${t.name}.${r}`).toContain(r);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('types every property', () => {
    for (const t of CAD_TOOLS) {
      for (const { path, schema } of schemas(t.inputSchema, t.name)) {
        expect('type' in schema || 'enum' in schema, path).toBe(true);
      }
    }
  });

  it('names no version-1 command, type or source path', () => {
    const text = JSON.stringify(CAD_TOOLS);
    for (const old of [
      '@tweakcad/core',
      'CadCommand',
      'dispatch_command',
      'stableFaceId',
      'stableEdgeId',
      'wireEntityIds',
      'CreateExtrude',
    ]) {
      expect(text).not.toContain(old);
    }
  });
});
