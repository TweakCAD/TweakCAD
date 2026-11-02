/**
 * Tests for the browser ToolHost's diagnostics builder.
 *
 * `buildDiagnostics` is the single source of truth used by both the
 * in-app chat ToolHost (`createBrowserToolHost`) and the MCP bridge
 * client. The cases here cover the discriminated-union of
 * FeatureBuildResult statuses plus the partId filter contract.
 */

import { describe, expect, it } from 'vitest';
import { buildDiagnostics } from './browserToolHost.ts';
import { newProjectWithPart, createPart } from '@tweakcad/core/src/document/factory.ts';
import type { CadProject, FeatureBuildResult, FeatureNode } from '@tweakcad/core/src/document/schema.ts';
import { featureId, partId } from '@tweakcad/core/src/ids.ts';
import type { FeatureId } from '@tweakcad/core/src/ids.ts';

/** Build a minimal FeatureNode for the timeline. The diagnostic builder
 *  only reads `id`, so other fields can be stub values. */
function fakeFeature(id: FeatureId): FeatureNode {
  return {
    id,
    type: 'extrude',
    name: 'F',
    version: 1,
    enabled: true,
    visible: true,
    suppressed: false,
    inputs: {},
  } as unknown as FeatureNode;
}

/** Project with one part that owns `featureIds`. */
function projectWithFeatures(featureIds: FeatureId[]): CadProject {
  const proj = newProjectWithPart('T', 'P');
  const onlyPart = Object.values(proj.parts)[0]!;
  for (const fid of featureIds) onlyPart.timeline.push(fakeFeature(fid));
  return proj;
}

describe('buildDiagnostics — empty input', () => {
  it('returns empty arrays when featureResults is empty', () => {
    const proj = projectWithFeatures([]);
    const out = buildDiagnostics({}, proj);
    expect(out.diagnostics).toEqual([]);
    expect(out.featureResults).toEqual({});
  });
});

describe('buildDiagnostics — status mapping', () => {
  it('success → no diagnostic, included in featureResults', () => {
    const f1 = featureId('f1');
    const proj = projectWithFeatures([f1]);
    const results: Record<FeatureId, FeatureBuildResult> = {
      [f1]: { featureId: f1, status: 'success', bodies: [] },
    };
    const out = buildDiagnostics(results, proj);
    expect(out.diagnostics).toEqual([]);
    expect(out.featureResults[f1]).toBeDefined();
  });

  it('success with warnings → one warning diagnostic carrying them', () => {
    // A sketch whose parameter-driven dimension could not be applied builds
    // at its last solved shape; the assistant has to be able to see that.
    const f1 = featureId('f1');
    const proj = projectWithFeatures([f1]);
    const results: Record<FeatureId, FeatureBuildResult> = {
      [f1]: { featureId: f1, status: 'success', bodies: [], warnings: ['Dimension "pcd" could not be evaluated.'] },
    };
    const out = buildDiagnostics(results, proj);
    expect(out.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'BUILT_WITH_WARNINGS',
        featureId: f1,
        message: 'Dimension "pcd" could not be evaluated.',
      }),
    ]);
  });

  it('suppressed → no diagnostic, included in featureResults', () => {
    const f1 = featureId('f1');
    const proj = projectWithFeatures([f1]);
    const results: Record<FeatureId, FeatureBuildResult> = {
      [f1]: { featureId: f1, status: 'suppressed' },
    };
    const out = buildDiagnostics(results, proj);
    expect(out.diagnostics).toEqual([]);
    expect(out.featureResults[f1]).toBeDefined();
  });

  it('blocked → warning diagnostic pointing at the upstream failure', () => {
    const f1 = featureId('f1');
    const f2 = featureId('f2');
    const proj = projectWithFeatures([f1, f2]);
    const results: Record<FeatureId, FeatureBuildResult> = {
      [f1]: { featureId: f1, status: 'blocked', blockedBy: f2 },
    };
    const out = buildDiagnostics(results, proj);
    expect(out.diagnostics).toHaveLength(1);
    const d = out.diagnostics[0]!;
    expect(d.severity).toBe('warning');
    expect(d.code).toBe('BLOCKED');
    expect(d.featureId).toBe(f1);
    expect(d.message).toContain(f2);
  });

  it('failed → error diagnostic carrying the FeatureError code', () => {
    const f1 = featureId('f1');
    const proj = projectWithFeatures([f1]);
    const results: Record<FeatureId, FeatureBuildResult> = {
      [f1]: {
        featureId: f1,
        status: 'failed',
        error: {
          category: 'geometry',
          code: 'EXTRUDE_FAILED',
          message: 'Profile self-intersects',
          suggestion: 'Check for overlapping segments',
        },
      },
    };
    const out = buildDiagnostics(results, proj);
    expect(out.diagnostics).toHaveLength(1);
    const d = out.diagnostics[0]!;
    expect(d.severity).toBe('error');
    expect(d.code).toBe('EXTRUDE_FAILED');
    expect(d.featureId).toBe(f1);
    // Suggestion is appended to the message when present.
    expect(d.message).toContain('Profile self-intersects');
    expect(d.message).toContain('Check for overlapping segments');
  });

  it('failed without suggestion → message is the bare error message', () => {
    const f1 = featureId('f1');
    const proj = projectWithFeatures([f1]);
    const results: Record<FeatureId, FeatureBuildResult> = {
      [f1]: {
        featureId: f1,
        status: 'failed',
        error: {
          category: 'kernel',
          code: 'OCCT_NULL_SHAPE',
          message: 'Kernel returned null shape',
        },
      },
    };
    const out = buildDiagnostics(results, proj);
    expect(out.diagnostics[0]!.message).toBe('Kernel returned null shape');
  });
});

describe('buildDiagnostics — partId filter', () => {
  it('without partId, returns diagnostics from all parts', () => {
    // Two parts, each with one failing feature.
    const proj = newProjectWithPart('Proj', 'A');
    const partA = Object.values(proj.parts)[0]!;
    const partB = createPart('B');
    proj.parts[partB.id] = partB;
    const fA = featureId('fA');
    const fB = featureId('fB');
    partA.timeline.push(fakeFeature(fA));
    partB.timeline.push(fakeFeature(fB));
    const results: Record<FeatureId, FeatureBuildResult> = {
      [fA]: { featureId: fA, status: 'failed', error: { category: 'geometry', code: 'A', message: 'a' } },
      [fB]: { featureId: fB, status: 'failed', error: { category: 'geometry', code: 'B', message: 'b' } },
    };
    const out = buildDiagnostics(results, proj);
    expect(out.diagnostics.map((d) => d.code).sort()).toEqual(['A', 'B']);
  });

  it('with partId, returns only diagnostics for that part', () => {
    const proj = newProjectWithPart('Proj', 'A');
    const partA = Object.values(proj.parts)[0]!;
    const partB = createPart('B');
    proj.parts[partB.id] = partB;
    const fA = featureId('fA');
    const fB = featureId('fB');
    partA.timeline.push(fakeFeature(fA));
    partB.timeline.push(fakeFeature(fB));
    const results: Record<FeatureId, FeatureBuildResult> = {
      [fA]: { featureId: fA, status: 'failed', error: { category: 'geometry', code: 'A', message: 'a' } },
      [fB]: { featureId: fB, status: 'failed', error: { category: 'geometry', code: 'B', message: 'b' } },
    };
    const out = buildDiagnostics(results, proj, partA.id);
    expect(out.diagnostics.map((d) => d.code)).toEqual(['A']);
    expect(Object.keys(out.featureResults)).toEqual([fA]);
  });

  it('with unknown partId, returns empty', () => {
    const f1 = featureId('f1');
    const proj = projectWithFeatures([f1]);
    const results: Record<FeatureId, FeatureBuildResult> = {
      [f1]: { featureId: f1, status: 'failed', error: { category: 'geometry', code: 'X', message: 'x' } },
    };
    const out = buildDiagnostics(results, proj, partId('part_does_not_exist'));
    expect(out.diagnostics).toEqual([]);
    expect(out.featureResults).toEqual({});
  });
});
