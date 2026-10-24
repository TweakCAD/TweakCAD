/**
 * Zod validation tests for the assembly slot.
 *
 * Nothing builds assemblies yet — `CadProject.assemblies` is `{}` in every
 * document the app writes. These tests exist because the slot was defined
 * pre-launch specifically so `instanceId` would not have to be retrofitted
 * later, and a shape nothing exercises is a shape that quietly rots. They
 * pin the two properties that cost a file migration if they ever slip:
 * instances are identified independently of what they place, and the `of`
 * union can address a sub-assembly as well as a part.
 */
import { describe, expect, it } from 'vitest';
import type { CadAssembly } from './schema.ts';
import { assemblyId, instanceId, partId } from '../ids.ts';
import { AssemblyInstanceSchema, CadAssemblySchema, CadPartSchema, CadProjectSchema } from './validation.ts';
import { createPart, emptyProject } from './factory.ts';

const IDENTITY = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };

describe('CadAssemblySchema', () => {
  it('accepts a root assembly holding part instances', () => {
    const asm: CadAssembly = {
      id: assemblyId('asm_root'),
      name: 'Bracket pair',
      root: true,
      instances: [
        { instanceId: instanceId('inst_l'), of: { kind: 'part', partId: partId('part_bracket') }, transform: IDENTITY },
        { instanceId: instanceId('inst_r'), of: { kind: 'part', partId: partId('part_bracket') }, transform: IDENTITY },
      ],
    };
    expect(CadAssemblySchema.safeParse(asm).success).toBe(true);
  });

  it('distinguishes two placements of the SAME part', () => {
    // The reason the slot exists. Both instances name one partId; only the
    // instanceId tells "the left bracket" from "the right bracket", and
    // joints / per-instance visibility / BOM counts all key on that.
    const asm = CadAssemblySchema.parse({
      id: 'asm_root',
      name: 'Bracket pair',
      root: true,
      instances: [
        { instanceId: 'inst_l', of: { kind: 'part', partId: 'part_bracket' }, transform: IDENTITY },
        { instanceId: 'inst_r', of: { kind: 'part', partId: 'part_bracket' }, transform: IDENTITY },
      ],
    });
    const parts = new Set(asm.instances.map(i => (i.of.kind === 'part' ? i.of.partId : null)));
    const ids = new Set(asm.instances.map(i => i.instanceId));
    expect(parts.size).toBe(1);
    expect(ids.size).toBe(2);
  });

  it('addresses a nested sub-assembly through the same union', () => {
    expect(
      AssemblyInstanceSchema.safeParse({
        instanceId: 'inst_sub',
        of: { kind: 'assembly', assemblyId: 'asm_gearbox' },
        transform: IDENTITY,
      }).success,
    ).toBe(true);
  });

  it('rejects an instance with no instanceId', () => {
    expect(
      AssemblyInstanceSchema.safeParse({
        of: { kind: 'part', partId: 'part_bracket' },
        transform: IDENTITY,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown `of` kind', () => {
    expect(
      AssemblyInstanceSchema.safeParse({
        instanceId: 'inst_1',
        of: { kind: 'body', bodyId: 'body_1' },
        transform: IDENTITY,
      }).success,
    ).toBe(false);
  });
});

describe('CadProject units + assemblies', () => {
  it('a fresh project carries no unit system — mm is the invariant', () => {
    const project = emptyProject('Test');
    expect(project).not.toHaveProperty('units');
    expect(project).not.toHaveProperty('displayUnits');
    expect(project.assemblies).toEqual({});
    expect(CadProjectSchema.safeParse(project).success).toBe(true);
  });

  it('a part carries no transform — placement lives on the instance', () => {
    const part = createPart('Bracket');
    expect(part).not.toHaveProperty('transform');
    expect(CadPartSchema.safeParse(part).success).toBe(true);
  });

  it('rejects a project whose assemblies hold malformed instances', () => {
    const project = emptyProject('Test') as unknown as Record<string, unknown>;
    project.assemblies = {
      asm_1: { id: 'asm_1', name: 'Broken', root: true, instances: [{ of: { kind: 'part', partId: 'p1' }, transform: IDENTITY }] },
    };
    expect(CadProjectSchema.safeParse(project).success).toBe(false);
  });
});
