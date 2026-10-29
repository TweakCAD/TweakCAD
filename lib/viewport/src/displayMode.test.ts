/**
 * Tests for computeAllBodyDisplayModes — the single function the rest
 * of the app routes ALL body display-mode decisions through.
 *
 * Priority rules (in order) we pin down here:
 *   1. hidden  — explicit per-body hide OR feature suppressed/hidden
 *   2. ghosted — sketch / profile-pick context (global), OR the body's
 *                part != activePartId (non-active parts, Fusion-style)
 *   3. normal  — default
 */
import { describe, expect, it } from 'vitest';
import { computeAllBodyDisplayModes } from './displayMode.ts';
import type { AllBodyModesInputs } from './displayMode.ts';
import type { CadProject, FeatureNode } from '@tweakcad/core/src/document/schema.ts';
import { bodyId, partId, featureId } from '@tweakcad/core/src/ids.ts';
import type { DisplayContext } from '@tweakcad/core/src/store/displayContextStore.ts';

function feat(id: string, overrides: Partial<FeatureNode> = {}): FeatureNode {
  return {
    id: featureId(id),
    type: 'extrude',
    name: id,
    version: 1,
    enabled: true,
    visible: true,
    inputs: {},
    dependsOn: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeProject(features: FeatureNode[], extraParts: Record<string, FeatureNode[]> = {}): CadProject {
  const parts: CadProject['parts'] = {
    [partId('p1')]: {
      id: partId('p1'),
      name: 'Part 1',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      parameters: { values: {} },
      timeline: features,
      defaultPlanes: {
        XY: { type: 'defaultPlane', name: 'XY' },
        XZ: { type: 'defaultPlane', name: 'XZ' },
        YZ: { type: 'defaultPlane', name: 'YZ' },
      },
    },
  };
  for (const [pid, timeline] of Object.entries(extraParts)) {
    parts[partId(pid)] = {
      id: partId(pid),
      name: pid,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      parameters: { values: {} },
      timeline,
      defaultPlanes: {
        XY: { type: 'defaultPlane', name: 'XY' },
        XZ: { type: 'defaultPlane', name: 'XZ' },
        YZ: { type: 'defaultPlane', name: 'YZ' },
      },
    };
  }
  return {
    schemaVersion: '0.2',
    metadata: { name: 'test', description: '', createdAt: '', updatedAt: '', appVersion: '0' },
    parameters: { values: {} },
    parts,
    references: {},
    assemblies: {},
  };
}

const VIEWING: DisplayContext = { mode: 'viewing' };
const SKETCH: DisplayContext = { mode: 'editingSketch', sketchId: featureId('sk1') };
const PROFILE: DisplayContext = { mode: 'selectingProfile', sketchId: featureId('sk1'), forFeatureId: null };
const FACE: DisplayContext = { mode: 'selectingFace', forFeatureId: featureId('ex1') };

function baseInputs(overrides: Partial<AllBodyModesInputs> = {}): AllBodyModesInputs {
  const f = feat('ex1');
  const project = makeProject([f]);
  return {
    bodyIds: [bodyId('b1')],
    project,
    bodyToFeatureMap: { b1: f.id },
    hiddenBodies: new Set<string>(),
    context: VIEWING,
    ...overrides,
  };
}

describe('computeAllBodyDisplayModes', () => {
  describe('priority 1: hidden', () => {
    it('hides bodies whose producing feature has visible=false', () => {
      const f = feat('ex1', { visible: false });
      const m = computeAllBodyDisplayModes(baseInputs({
        project: makeProject([f]),
      }));
      expect(m.get(bodyId('b1'))).toBe('hidden');
    });

    it('hides bodies whose producing feature is suppressed (enabled=false)', () => {
      const f = feat('ex1', { enabled: false });
      const m = computeAllBodyDisplayModes(baseInputs({
        project: makeProject([f]),
      }));
      expect(m.get(bodyId('b1'))).toBe('hidden');
    });

    it('hides bodies in the hiddenBodies set (eye-icon toggle)', () => {
      const m = computeAllBodyDisplayModes(baseInputs({
        hiddenBodies: new Set(['b1']),
      }));
      expect(m.get(bodyId('b1'))).toBe('hidden');
    });

    it('hides even in sketch context — hidden beats ghosted', () => {
      // Bug A regression: entering sketch mode used to make hidden
      // bodies visible-ghosted. The hidden state must win.
      const m = computeAllBodyDisplayModes(baseInputs({
        hiddenBodies: new Set(['b1']),
        context: SKETCH,
      }));
      expect(m.get(bodyId('b1'))).toBe('hidden');
    });

    it('hides when feature.visible is false even in sketch context', () => {
      const f = feat('ex1', { visible: false });
      const m = computeAllBodyDisplayModes(baseInputs({
        project: makeProject([f]),
        context: SKETCH,
      }));
      expect(m.get(bodyId('b1'))).toBe('hidden');
    });
  });

  describe('priority 2: ghosted', () => {
    it('ghosts all visible bodies in editingSketch mode', () => {
      const m = computeAllBodyDisplayModes(baseInputs({ context: SKETCH }));
      expect(m.get(bodyId('b1'))).toBe('ghosted');
    });

    it('ghosts all visible bodies in selectingProfile mode', () => {
      const m = computeAllBodyDisplayModes(baseInputs({ context: PROFILE }));
      expect(m.get(bodyId('b1'))).toBe('ghosted');
    });

    it('does NOT ghost in selectingFace / viewing modes', () => {
      expect(computeAllBodyDisplayModes(baseInputs({ context: FACE })).get(bodyId('b1'))).toBe('normal');
      expect(computeAllBodyDisplayModes(baseInputs({ context: VIEWING })).get(bodyId('b1'))).toBe('normal');
    });

    it('returns to ghosted after unhide in sketch context — Bug B regression', () => {
      // Bug B: hide a body in sketch mode, unhide it; it used to come
      // back as 'normal' (the eye-icon handler hard-coded normal/hidden
      // and ignored context). With the centralized compute, unhide
      // means "remove from hiddenBodies" and the next pass reads
      // SKETCH context → ghosted.
      const m = computeAllBodyDisplayModes(baseInputs({
        hiddenBodies: new Set<string>(), // already removed
        context: SKETCH,
      }));
      expect(m.get(bodyId('b1'))).toBe('ghosted');
    });
  });

  describe('priority 3: normal default', () => {
    it('returns normal for visible bodies in viewing mode', () => {
      expect(computeAllBodyDisplayModes(baseInputs()).get(bodyId('b1'))).toBe('normal');
    });

    it('treats orphan bodies (no producing feature) as normal', () => {
      // Mid-rebuild swap or a body whose featureId isn't in the
      // bodyToFeatureMap shouldn't blink out — better to flicker
      // visible for one frame than to disappear entirely.
      const m = computeAllBodyDisplayModes(baseInputs({
        bodyToFeatureMap: {}, // no mapping at all
      }));
      expect(m.get(bodyId('b1'))).toBe('normal');
    });
  });

  describe('activePartId (non-active part ghosting)', () => {
    it('ghosts bodies in non-active parts when activePartId set', () => {
      const f1 = feat('ex_p1');
      const f2 = feat('ex_p2');
      const project = makeProject([f1], { p2: [f2] });
      const m = computeAllBodyDisplayModes({
        bodyIds: [bodyId('b1'), bodyId('b2')],
        project,
        bodyToFeatureMap: { b1: f1.id, b2: f2.id },
        hiddenBodies: new Set<string>(),
        context: VIEWING,
        activePartId: partId('p1'),
      });
      expect(m.get(bodyId('b1'))).toBe('normal');
      expect(m.get(bodyId('b2'))).toBe('ghosted');
    });

    it('does nothing when activePartId is undefined', () => {
      const f1 = feat('ex_p1');
      const f2 = feat('ex_p2');
      const project = makeProject([f1], { p2: [f2] });
      const m = computeAllBodyDisplayModes({
        bodyIds: [bodyId('b1'), bodyId('b2')],
        project,
        bodyToFeatureMap: { b1: f1.id, b2: f2.id },
        hiddenBodies: new Set<string>(),
        context: VIEWING,
      });
      expect(m.get(bodyId('b1'))).toBe('normal');
      expect(m.get(bodyId('b2'))).toBe('normal');
    });
  });

  describe('multi-body integration', () => {
    it('mixes the three priorities correctly across many bodies', () => {
      const f1 = feat('ex1');                    // visible → ghosted (sketch context)
      const f2 = feat('ex2', { visible: false }); // → hidden
      const f3 = feat('ex3');                    // in hiddenBodies → hidden
      const project = makeProject([f1, f2, f3]);
      const m = computeAllBodyDisplayModes({
        bodyIds: [bodyId('b1'), bodyId('b2'), bodyId('b3')],
        project,
        bodyToFeatureMap: { b1: f1.id, b2: f2.id, b3: f3.id },
        hiddenBodies: new Set(['b3']),
        context: SKETCH,
      });
      expect(m.get(bodyId('b1'))).toBe('ghosted');
      expect(m.get(bodyId('b2'))).toBe('hidden');
      expect(m.get(bodyId('b3'))).toBe('hidden');
    });
  });
});
