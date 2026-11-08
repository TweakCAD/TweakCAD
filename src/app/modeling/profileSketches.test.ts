import { describe, expect, it } from 'vitest';
import type { Json } from '@tweakcad/editor';
import { createAppStore } from '../appState';
import { loftSketches, newLoftForm } from './loft';
import { profileSketches, showSketches, sketchesNamedIn, sketchesToShow, sketchOfReference } from './profileSketches';
import { newSweepForm, sweepSketches, type ChainPick } from './sweep';

const doc: Json = {
  names: {
    curveOfS2: { kind: 'curve', chain: [], feature: { id: 's2' } },
    faceOfE1: { kind: 'face', chain: [], feature: { id: 'e1' } },
  },
  parts: [
    {
      id: 'p',
      timeline: [
        { id: 's1', type: 'core.sketch' },
        { id: 's2', type: 'core.sketch' },
        { id: 'e1', type: 'core.extrude' },
      ],
    },
    { id: 'q', timeline: [{ id: 's9', type: 'core.sketch' }] },
  ],
};

const lost = { kept: { entity: { id: [], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } } };
const lineOf = (hash: string) => ({
  entity: { id: [hash], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} },
});
const sketchNormal = (id: string) => ({ normal: { ref: { object: { feature: { id } } }, reversed: {} } });

describe('sketchesToShow', () => {
  it('shows the sketches the profiles come from, once each', () => {
    expect(sketchesToShow(['s1', 's1', null, 's2'], ['s9'], 's3')).toEqual(['s1', 's2']);
  });

  it('with every profile lost, shows the sketches the other inputs name', () => {
    expect(sketchesToShow([null], ['s2'], 's3')).toEqual(['s2']);
    expect(sketchesToShow([], ['s2'], 's3')).toEqual(['s2']);
  });

  it('with neither, shows the sketch the panel started from, or nothing', () => {
    expect(sketchesToShow([null], [], 's3')).toEqual(['s3']);
    expect(sketchesToShow([], [], undefined)).toEqual([]);
  });
});

describe('the sketch a reference names', () => {
  it('reads a whole sketch, or a curve of one by its name', () => {
    expect(sketchOfReference(doc, 'p', { object: { feature: { id: 's1' } } })).toBe('s1');
    expect(sketchOfReference(doc, 'p', lineOf('curveOfS2'))).toBe('s2');
  });

  it('reads a name the form holds that the document does not have yet', () => {
    expect(
      sketchOfReference(doc, 'p', lineOf('fresh'), { fresh: { kind: 'curve', chain: [], feature: { id: 's1' } } }),
    ).toBe('s1');
  });

  it('names no sketch for model geometry, a standard axis, another part, or an empty record', () => {
    expect(sketchOfReference(doc, 'p', lineOf('faceOfE1'))).toBeNull();
    expect(sketchOfReference(doc, 'p', { object: { feature: { id: 'e1' } } })).toBeNull();
    expect(sketchOfReference(doc, 'p', { standard: { name: 'y' } })).toBeNull();
    expect(sketchOfReference(doc, 'p', { object: { feature: { id: 's9' } } })).toBeNull();
    expect(sketchOfReference(doc, 'p', lost.kept)).toBeNull();
  });

  it('finds the references anywhere in an input', () => {
    expect(sketchesNamedIn(doc, 'p', [sketchNormal('s2'), { along: { ref: lineOf('curveOfS2') } }, undefined])).toEqual(
      ['s2'],
    );
  });
});

describe('profileSketches', () => {
  it('takes the profiles first, then a direction from a sketch, then the starting sketch', () => {
    expect(
      profileSketches(doc, 'p', {
        profiles: [{ sketch: 's1', row: 'r' }],
        references: [sketchNormal('s2')],
        from: 's2',
      }),
    ).toEqual(['s1']);
    expect(profileSketches(doc, 'p', { profiles: [lost], references: [sketchNormal('s2')] })).toEqual(['s2']);
    expect(
      profileSketches(doc, 'p', { profiles: [lost], references: [{ standard: { name: 'y' } }], from: 's1' }),
    ).toEqual(['s1']);
  });

  it('counts a lost profile whose reference still names its sketch', () => {
    expect(
      profileSketches(doc, 'p', { profiles: [{ kept: lineOf('curveOfS2') }], references: [sketchNormal('s1')] }),
    ).toEqual(['s2']);
  });
});

describe('showSketches', () => {
  it('sets the shown sketches until it is undone, without touching a later list', () => {
    const app = createAppStore();
    const undo = showSketches(app, ['s2']);
    expect(app.getState().shownSketches).toEqual(['s2']);
    undo();
    expect(app.getState().shownSketches).toEqual([]);
    const first = showSketches(app, ['s1']);
    showSketches(app, ['s2']);
    first();
    expect(app.getState().shownSketches).toEqual(['s2']);
  });
});

describe('the sketches of a sweep and a loft', () => {
  const pathOf = (hash: string): ChainPick => ({ reference: lineOf(hash), names: {}, label: 'Path' });
  const row = (sketch: string) => ({ sketch, row: `row_${sketch}` });

  it('shows what runs alongside the profiles with them, not only without them', () => {
    expect(profileSketches(doc, 'p', { profiles: [row('s1')], references: [lineOf('curveOfS2')] })).toEqual(['s1']);
    expect(profileSketches(doc, 'p', { profiles: [row('s1')], alongside: [lineOf('curveOfS2')] })).toEqual([
      's1',
      's2',
    ]);
    expect(
      profileSketches(doc, 'p', { profiles: [row('s1')], alongside: [{ object: { feature: { id: 's1' } } }] }),
    ).toEqual(['s1']);
  });

  it("shows a sweep's profile and path sketches, and its guide's only when it follows one", () => {
    const form = { ...newSweepForm('sec', false), profiles: [row('s1')], path: [pathOf('curveOfS2')] };
    expect(profileSketches(doc, 'p', sweepSketches(form, undefined))).toEqual(['s1', 's2']);
    const guide: ChainPick = { reference: { object: { feature: { id: 's1' } } }, names: {}, label: 'Guide' };
    const other = { ...form, profiles: [row('s2')], path: [], guide: [guide] };
    expect(profileSketches(doc, 'p', sweepSketches(other, undefined))).toEqual(['s2']);
    expect(profileSketches(doc, 'p', sweepSketches({ ...other, orientation: 'guide' }, undefined))).toEqual([
      's2',
      's1',
    ]);
  });

  it('reads a path picked in this panel by the names the pick holds', () => {
    const fresh: ChainPick = {
      reference: lineOf('fresh'),
      names: { fresh: { kind: 'curve', chain: [], feature: { id: 's2' } } },
      label: 'Path',
    };
    const form = { ...newSweepForm('sec', false), profiles: [row('s1')], path: [fresh] };
    expect(profileSketches(doc, 'p', sweepSketches(form, undefined))).toEqual(['s1', 's2']);
  });

  it("with a sweep's profile lost, still shows the path, and the sketch it started from", () => {
    const form = { ...newSweepForm('sec', false), profiles: [lost], path: [pathOf('curveOfS2')] };
    expect(profileSketches(doc, 'p', sweepSketches(form, 's1'))).toEqual(['s1', 's2']);
  });

  it("shows every section's sketch of a loft, and those of its rails and written sections", () => {
    const sections = [
      { id: 'a', profile: row('s1') },
      { id: 'b', profile: lost },
    ];
    const form = { ...newLoftForm(false), sections };
    expect(profileSketches(doc, 'p', loftSketches(form, undefined, undefined))).toEqual(['s1']);
    expect(profileSketches(doc, 'p', loftSketches(form, { rails: [[lineOf('curveOfS2')]] }, undefined))).toEqual([
      's1',
      's2',
    ]);
    const written = {
      ...form,
      sections: [
        { id: 'a', profile: row('s2') },
        { id: 'c', written: { profiles: { set: [{ object: { feature: { id: 's1' } } }] } } },
      ],
    };
    expect(profileSketches(doc, 'p', loftSketches(written, undefined, undefined))).toEqual(['s2', 's1']);
  });
});
