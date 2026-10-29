/**
 * Tests for the feature → owner part lookup and active-part resolution.
 *
 * These two functions are what multi-part correctness rests on in the
 * UI: every mutating command is addressed `{ partId, featureId }`, and
 * before they existed the caller passed the first part — which is right
 * exactly as long as there is only one.
 */

import { describe, expect, it } from 'vitest';
import { emptyProject } from './factory.ts';
import type { CadProject, CadPart, FeatureNode } from './schema.ts';
import { featureId, partId } from '../ids.ts';
import { findFeature, findFeaturePartId, resolveActivePartId } from './featureLookup.ts';

function feature(id: string): FeatureNode {
  return {
    id: featureId(id),
    type: 'sketch',
    name: id,
    enabled: true,
    visible: true,
    inputs: {},
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
  } as unknown as FeatureNode;
}

function part(id: string, featureIds: string[]): CadPart {
  return {
    id: partId(id),
    name: id,
    parameters: { values: {} },
    timeline: featureIds.map(feature),
    defaultPlanes: {
      XY: { type: 'defaultPlane', name: 'XY' },
      XZ: { type: 'defaultPlane', name: 'XZ' },
      YZ: { type: 'defaultPlane', name: 'YZ' },
    },
  } as unknown as CadPart;
}

/** A project whose parts are inserted in the given order. */
function project(...parts: CadPart[]): CadProject {
  const p = emptyProject('Test');
  for (const part of parts) p.parts[part.id] = part;
  return p;
}

describe('findFeature', () => {
  it('finds a feature in the second part', () => {
    const p = project(part('p1', ['a', 'b']), part('p2', ['c']));
    const found = findFeature(p, 'c');
    expect(found?.partId).toBe('p2');
    expect(found?.feature.name).toBe('c');
  });

  it('finds a feature in the first part', () => {
    const p = project(part('p1', ['a']), part('p2', ['c']));
    expect(findFeaturePartId(p, 'a')).toBe('p1');
  });

  it('returns null for an id no part holds', () => {
    const p = project(part('p1', ['a']));
    expect(findFeature(p, 'ghost')).toBeNull();
    expect(findFeaturePartId(p, 'ghost')).toBeNull();
  });

  it('returns null on a project with no parts', () => {
    expect(findFeaturePartId(emptyProject('Empty'), 'a')).toBeNull();
  });
});

describe('resolveActivePartId', () => {
  it('keeps an active part that still exists', () => {
    const p = project(part('p1', []), part('p2', []));
    expect(resolveActivePartId(p, partId('p2'))).toBe('p2');
  });

  it('falls back to the first part when nothing is active', () => {
    const p = project(part('p1', []), part('p2', []));
    expect(resolveActivePartId(p, null)).toBe('p1');
    expect(resolveActivePartId(p, undefined)).toBe('p1');
  });

  it('falls back when the active part went away', () => {
    // What an undo of `CreatePart` leaves behind: a stale id in session
    // state naming a part the document no longer has.
    const p = project(part('p1', []));
    expect(resolveActivePartId(p, partId('p2'))).toBe('p1');
  });

  it('returns null for a project with no parts', () => {
    expect(resolveActivePartId(emptyProject('Empty'), null)).toBeNull();
  });
});
