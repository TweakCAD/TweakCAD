import { describe, expect, it } from 'vitest';
import type { Json } from '@tweakcad/editor';
import type { ListedBody, PlacedReference } from '@tweakcad/worker/src/v2/service/types';
import { picksInForm, placedLabel, recordOf, relabelled, storedLabels } from './beforeState';
import type { PickedRef } from './feature';

const entity = (hash: string): Json => ({
  entity: { id: [hash], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} },
});
const pick = (reference: Json, label: string): PickedRef => ({ reference, names: {}, label });
const listed = (id: string, name: string): ListedBody => ({
  key: 0,
  id,
  feature: 'feat_a',
  name,
  color: '#6699cc',
  opacity: 1,
  visible: true,
});
const bodies = [listed('rim', 'Body 1'), listed('win', 'Body 2'), listed('cyl', 'Body 3')];

describe('picks read in the state before a feature', () => {
  it('finds every pick a form holds, wherever it sits', () => {
    const form = {
      op: 'cut',
      target: pick(entity('a'), 'Target body'),
      tools: [pick(entity('b'), 'Tool body 1')],
      axis: { picked: pick(entity('c'), 'Axis') },
      plane: null,
    };
    expect(picksInForm(form).map((p) => p.label)).toEqual(['Target body', 'Tool body 1', 'Axis']);
    expect(recordOf(entity('a'))).not.toBeNull();
    expect(recordOf({ standard: { name: 'xy' } })).toBeNull();
  });

  it('names a body, face or edge by the body it lies on there, and a reference that lands nowhere as missing', () => {
    const at = (found: boolean, kind: PlacedReference['kind'], body: string | null): PlacedReference => ({
      found,
      kind,
      body,
    });
    expect(placedLabel(at(true, 'body', 'cyl'), bodies)).toEqual({ label: 'Body 3' });
    expect(placedLabel(at(true, 'face', 'win'), bodies)).toEqual({ label: 'Face of Body 2' });
    expect(placedLabel(at(true, 'edge', 'rim'), bodies)).toEqual({ label: 'Edge of Body 1' });
    expect(placedLabel(at(false, 'body', null), bodies)).toEqual({ label: 'Missing body', missing: true });
    expect(placedLabel(at(false, 'face', null), bodies)).toEqual({ label: 'Missing face', missing: true });
    expect(placedLabel(at(false, null, null), bodies)).toEqual({ label: 'Missing reference', missing: true });
    // A sketch curve keeps the label it has.
    expect(placedLabel(at(true, 'curve', null), bodies)).toBeNull();
  });

  it('relabels a form by reference, keeping what it does not hold, and names features or marks them missing', () => {
    const target = pick(entity('a'), 'Target body');
    const tools = [pick(entity('b'), 'Tool body 1'), pick(entity('c'), 'Tool body 2')];
    const feature = pick({ object: { feature: { id: 'feat_e' } } }, 'Feature');
    const gone = pick({ object: { feature: { id: 'feat_gone' } } }, 'Feature');
    const plane = pick({ standard: { name: 'xy' } }, 'XY plane');
    const form = { op: 'cut' as const, target, tools, features: [feature, gone], plane };
    const placed: PlacedReference[] = [
      { found: true, kind: 'body', body: 'rim' },
      { found: true, kind: 'body', body: 'win' },
      { found: false, kind: 'body', body: null },
    ];
    const labels = storedLabels(
      picksInForm(form),
      [target.reference, ...tools.map((t) => t.reference)],
      placed,
      bodies,
      (id) => (id === 'feat_e' ? 'Extrude 1' : null),
    );
    const next = relabelled(form, labels);
    expect(next.target.label).toBe('Body 1');
    expect(next.tools.map((t) => [t.label, t.missing ?? false])).toEqual([
      ['Body 2', false],
      ['Missing body', true],
    ]);
    expect(next.features.map((f) => [f.label, f.missing ?? false])).toEqual([
      ['Extrude 1', false],
      ['Missing feature', true],
    ]);
    expect(next.plane).toBe(plane);
    expect(next.target.reference).toBe(target.reference);
    // Labels already in place leave the form as it is.
    expect(relabelled(next, labels)).toBe(next);
  });
});
