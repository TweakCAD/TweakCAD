/**
 * Integration test for the component-insertion flow.
 *
 * Exercises the same regression a UI e2e would cover, but through the
 * command bus + handler + store layer — the panel's React rendering is a
 * thin shell that ultimately dispatches CreateComponentInstance with the
 * values produced by `initialParameterValues` and `coerceParameterValue`.
 *
 * Why this and not Playwright: this codebase has zero e2e infrastructure
 * today, and the user's supply-chain policy keeps deps minimal — pure
 * vitest is the established pattern (sketchSolver.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import { CommandBus } from '@tweakcad/core/src/commands/bus.ts';
import { createComponentInstanceHandler } from '@tweakcad/core/src/commands/handlers/featureCommands.ts';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import type { ComponentDetail, ComponentManifest } from '@tweakcad/api-types';
import type {
  CadPart,
  ComponentInstanceFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import type { PartId } from '@tweakcad/core/src/ids.ts';
import {
  coerceParameterValue,
  initialParameterValues,
} from './parameters.ts';

function makeDetail(overrides: Partial<ComponentDetail> = {}): ComponentDetail {
  const manifest: ComponentManifest = {
    schemaVersion: 1,
    standard: 'ISO 4017',
    parameters: [
      { name: 'length', label: 'Length', type: 'number', default: 20, range: [6, 120] },
      { name: 'grade', label: 'Grade', type: 'enum', default: '8.8', values: ['8.8', '10.9', '12.9'] },
    ],
    installHint: 'Snaps head-down.',
  };
  return {
    id: 'proj_m5_bolt',
    slug: 'iso-4017-hex-bolt-m5',
    name: 'M5 hex bolt — ISO 4017',
    description: 'Hex bolt',
    tags: ['fastener'],
    categoryId: null,
    categoryName: null,
    thumbnailUrl: null,
    ownerUsername: null,
    ownerDisplayName: null,
    ownerAvatarUrl: null,
    likeCount: 0,
    viewCount: 0,
    updatedAt: '2026-05-01T00:00:00.000Z',
    standard: 'ISO 4017',
    status: 'published',
    manifest,
    reviewedAt: null,
    createdAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildWiredApp() {
  const project = newProjectWithPart('Test Project', 'Part 1');
  const partId = Object.keys(project.parts)[0]! as PartId;
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateComponentInstance', createComponentInstanceHandler);
  return { store, bus, partId };
}

function getPart(store: DocumentStore, partId: PartId): CadPart {
  const part = store.getState().parts[partId];
  if (!part) throw new Error('test setup: missing part');
  return part;
}

describe('component insertion flow', () => {
  it('appends a componentInstance feature node when Insert is dispatched', () => {
    const { store, bus, partId } = buildWiredApp();
    const detail = makeDetail();
    const values = initialParameterValues(detail.manifest);

    const result = bus.dispatch({
      type: 'CreateComponentInstance',
      partId,
      inputs: {
        componentProjectId: detail.id,
        componentSlug: detail.slug,
        componentName: detail.name,
        manifestVersion: detail.manifest.schemaVersion,
        parameters: values,
      },
    });

    expect(result.ok).toBe(true);

    const part = getPart(store, partId);
    expect(part.timeline).toHaveLength(1);
    const feature = part.timeline[0]!;
    expect(feature.type).toBe('componentInstance');
    expect(feature.name).toBe(detail.name);
    expect(feature.enabled).toBe(true);

    const inputs = feature.inputs as unknown as ComponentInstanceFeatureInputs;
    expect(inputs.componentSlug).toBe('iso-4017-hex-bolt-m5');
    expect(inputs.componentProjectId).toBe('proj_m5_bolt');
    expect(inputs.parameters).toEqual({ length: 20, grade: '8.8' });
    expect(inputs.manifestVersion).toBe(1);
  });

  it('persists user-edited parameter values through the dispatch', () => {
    // Simulates: user clicks an M5 card, the configure form opens with
    // defaults, they slide Length from 20 → 50 and switch grade to 10.9,
    // then click Insert. The stored feature node should carry the edits.
    const { store, bus, partId } = buildWiredApp();
    const detail = makeDetail();
    const lengthParam = detail.manifest.parameters[0]!;
    const gradeParam = detail.manifest.parameters[1]!;

    const values = initialParameterValues(detail.manifest);
    values[lengthParam.name] = coerceParameterValue(lengthParam, '50');
    values[gradeParam.name] = coerceParameterValue(gradeParam, '10.9');

    bus.dispatch({
      type: 'CreateComponentInstance',
      partId,
      inputs: {
        componentProjectId: detail.id,
        componentSlug: detail.slug,
        componentName: detail.name,
        manifestVersion: detail.manifest.schemaVersion,
        parameters: values,
      },
    });

    const part = getPart(store, partId);
    const inputs = part.timeline[0]!.inputs as unknown as ComponentInstanceFeatureInputs;
    expect(inputs.parameters).toEqual({ length: 50, grade: '10.9' });
  });

  it('clamps an out-of-range numeric edit before dispatching', () => {
    const { store, bus, partId } = buildWiredApp();
    const detail = makeDetail();
    const lengthParam = detail.manifest.parameters[0]!;

    const values = initialParameterValues(detail.manifest);
    // 999 is out of [6, 120] — the panel coercer must clamp before dispatch
    // so the document never holds a value the manifest's range forbids.
    values[lengthParam.name] = coerceParameterValue(lengthParam, '999');

    bus.dispatch({
      type: 'CreateComponentInstance',
      partId,
      inputs: {
        componentProjectId: detail.id,
        componentSlug: detail.slug,
        componentName: detail.name,
        manifestVersion: detail.manifest.schemaVersion,
        parameters: values,
      },
    });

    const part = getPart(store, partId);
    const inputs = part.timeline[0]!.inputs as unknown as ComponentInstanceFeatureInputs;
    expect(inputs.parameters.length).toBe(120);
  });

  it('numbers repeat insertions of the same component for the timeline', () => {
    const { store, bus, partId } = buildWiredApp();
    const detail = makeDetail();
    const values = initialParameterValues(detail.manifest);

    bus.dispatch({
      type: 'CreateComponentInstance',
      partId,
      inputs: {
        componentProjectId: detail.id,
        componentSlug: detail.slug,
        componentName: detail.name,
        manifestVersion: detail.manifest.schemaVersion,
        parameters: values,
      },
    });
    bus.dispatch({
      type: 'CreateComponentInstance',
      partId,
      inputs: {
        componentProjectId: detail.id,
        componentSlug: detail.slug,
        componentName: detail.name,
        manifestVersion: detail.manifest.schemaVersion,
        parameters: values,
      },
    });

    const part = getPart(store, partId);
    expect(part.timeline).toHaveLength(2);
    expect(part.timeline[0]!.name).toBe(detail.name);
    expect(part.timeline[1]!.name).toBe(`${detail.name} (2)`);
  });

  it('rejects an empty componentSlug with a validation error', () => {
    const { store, bus, partId } = buildWiredApp();

    const result = bus.dispatch({
      type: 'CreateComponentInstance',
      partId,
      inputs: {
        componentProjectId: 'proj_x',
        componentSlug: '',
        componentName: 'Test',
        manifestVersion: 1,
        parameters: {},
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
    }
    expect(getPart(store, partId).timeline).toHaveLength(0);
  });
});

describe('componentInstance schema round-trip', () => {
  it('JSON-serializes and parses without losing fields', () => {
    const { store, bus, partId } = buildWiredApp();
    const detail = makeDetail();

    bus.dispatch({
      type: 'CreateComponentInstance',
      partId,
      inputs: {
        componentProjectId: detail.id,
        componentSlug: detail.slug,
        componentName: detail.name,
        manifestVersion: detail.manifest.schemaVersion,
        parameters: initialParameterValues(detail.manifest),
      },
    });

    const before = store.getState();
    const serialized = JSON.stringify(before);
    const parsed = JSON.parse(serialized);

    const part = parsed.parts[partId];
    expect(part.timeline[0].type).toBe('componentInstance');
    expect(part.timeline[0].inputs.componentSlug).toBe(detail.slug);
    expect(part.timeline[0].inputs.parameters.length).toBe(20);
  });
});
