import { describe, expect, it } from 'vitest';
import { Editor, type Json } from '@tweakcad/editor';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import {
  bodiesOf,
  featureDisplayName,
  featureTypeLabel,
  findFeature,
  iconKeyOf,
  markerWhileEditing,
  partOfFeature,
  partView,
  shownRoot,
  type FeatureRow,
  type PartView,
} from './features';

function plate() {
  const d = new DocBuilder();
  const s = d.sketch('xy', (x) => x.rect(0, 0, 60, 40));
  const extrude = d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])] });
  const hole = d.sketch('xy', (x) => x.circle(45, 20, 3));
  const cut = d.extrude({
    sketch: hole.feature,
    profiles: [hole.region([45, 20])],
    sides: [{ throughAll: true }],
    op: 'cut',
  });
  return { doc: d.document(), part: d.partId, sketch: s.feature, extrude, hole: hole.feature, cut };
}

const display = (o: Partial<Display>): Display => ({
  generation: 1,
  definitions: [],
  parts: {},
  assemblies: [],
  entities: [],
  pauses: [],
  stale: [],
  outOfDate: [],
  timing: { evaluate: 0, display: 0, resumed: 0 },
  ...o,
});

describe('partView', () => {
  it('lists the timeline with icon keys and the rollback at the end', () => {
    const p = plate();
    const view = partView(p.doc, p.part, null)!;
    expect(view.features.map((f) => f.iconKey)).toEqual(['sketch', 'extrude', 'sketch', 'extrude']);
    expect(view.features.every((f) => f.status === 'success')).toBe(true);
    expect(view.rollbackIndex).toBe(4);
    expect(shownRoot(p.doc)).toEqual({ part: p.part });
  });

  it('shows a pause as a failure with its message, and what it holds up as blocked', () => {
    const p = plate();
    const view = partView(
      p.doc,
      p.part,
      display({
        pauses: [{ feature: p.extrude, message: 'The profile is gone.', through: [p.cut] }],
        stale: [{ feature: p.hole, message: 'stale' }],
      }),
    )!;
    const byId = new Map(view.features.map((f) => [f.id, f]));
    expect(byId.get(p.extrude)).toMatchObject({ status: 'failed', message: 'The profile is gone.' });
    expect(byId.get(p.cut)).toMatchObject({ status: 'blocked', message: 'The profile is gone.' });
    // A frozen feature replaying over a changed body built, not as authored: a warning, not a block.
    expect(byId.get(p.hole)).toMatchObject({ status: 'success', warning: 'stale' });
  });

  it('follows suppression and rollback edits made through commands', () => {
    const p = plate();
    const editor = new Editor(p.doc);
    expect(editor.dispatch({ type: 'setSuppressed', feature: p.cut, suppressed: true }).ok).toBe(true);
    expect(editor.dispatch({ type: 'setRollback', part: p.part, before: p.hole }).ok).toBe(true);
    const view = partView(editor.document, p.part, null)!;
    expect(view.features[3]).toMatchObject({ suppressed: true, status: 'suppressed' });
    expect(view.rollbackIndex).toBe(2);
  });

  it('shows a feature suppressed by an expression, as it is evaluated', () => {
    const p = plate();
    const flag = (findFeature(p.doc, p.cut) as Json).suppressed as Json;
    for (const [text, suppressed] of [
      ['1 == 1', true],
      ['1 == 2', false],
    ] as const) {
      const doc = structuredClone(p.doc);
      ((doc.parts as Json[])[0]!.timeline as Json[])[3]!.suppressed = {
        ...flag,
        def: { expr: { text, grammar: 1, refs: {} } },
      };
      expect(partView(doc, p.part, null)!.features[3]).toMatchObject({
        suppressed,
        status: suppressed ? 'suppressed' : 'success',
      });
    }
  });

  it('carries the degrees of freedom of each sketch from the display', () => {
    const p = plate();
    const sketches = [p.sketch, p.hole].map((feature, i) => ({
      feature,
      dof: i === 0 ? 0 : 3,
    })) as unknown as Display['definitions'][number]['sketches'];
    const shown = display({
      parts: { [p.part]: 0 },
      definitions: [
        { index: 0, part: p.part, bodies: [], sketches, construction: [] } as unknown as Display['definitions'][number],
      ],
    });
    const byId = new Map(partView(p.doc, p.part, shown)!.features.map((f) => [f.id, f]));
    expect(byId.get(p.sketch)?.dof).toBe(0);
    expect(byId.get(p.hole)?.dof).toBe(3);
    expect(byId.get(p.extrude)?.dof).toBeUndefined();
    // A paused sketch shows its failure, not a count.
    const paused = partView(p.doc, p.part, { ...shown, pauses: [{ feature: p.hole, message: 'does not solve' }] })!;
    expect(paused.features.find((f) => f.id === p.hole)?.dof).toBeUndefined();
  });

  it('finds a feature and its part', () => {
    const p = plate();
    expect(partOfFeature(p.doc, p.cut)).toBe(p.part);
    expect((findFeature(p.doc, p.hole) as Json).type).toBe('core.sketch');
    expect(partOfFeature(p.doc, 'feat_none')).toBeNull();
  });
});

describe('bodiesOf', () => {
  const body = (key: number, id: string, name: string, feature: string) => ({
    key,
    id,
    name,
    feature,
    color: '#6699cc',
    opacity: 1,
    visible: true,
    faceStyles: [],
    mesh: {},
  });
  const withBodies = (bodies: ReturnType<typeof body>[]) =>
    display({
      parts: { part_1: 0 },
      definitions: [
        {
          index: 0,
          part: 'part_1',
          variant: '',
          rollback: null,
          bodies,
          sketches: [],
          construction: [],
        } as unknown as Display['definitions'][number],
      ],
    });

  it('gives one row per body, keyed by its own key', () => {
    const shown = withBodies([
      body(1, 'a', 'Body 1', 'feat_e'),
      body(4, 'b', 'Body 2', 'feat_x'),
      body(9, 'c', 'Body 3', 'feat_x'),
    ]);
    expect(bodiesOf(shown, 'part_1').map((b) => [b.key, b.name])).toEqual([
      [1, 'Body 1'],
      [4, 'Body 2'],
      [9, 'Body 3'],
    ]);
  });

  it("lists the committed display's bodies, keyed by the preview's key for the same body", () => {
    const committed = withBodies([body(1, 'a', 'Body 1', 'feat_e'), body(2, 'b', 'Body 2', 'feat_x')]);
    // The preview numbers its keys afresh, adds a body and lacks one the committed model has.
    const preview = withBodies([body(7, 'b', 'Body 1', 'feat_x'), body(8, 'n', 'Body 2', 'feat_new')]);
    expect(bodiesOf(preview, 'part_1', committed).map((b) => [b.key, b.name])).toEqual([
      [-1, 'Body 1'],
      [7, 'Body 2'],
    ]);
  });

  it("lists the part just before an open panel's feature, keyed by the shown display, else by the listing while it is current", () => {
    // Editing a cut: the committed model has the target alone; before the cut, the target and two tools.
    const committed = withBodies([body(1, 'plate', 'Body 2', 'feat_plate')]);
    const preview = {
      ...withBodies([body(5, 'plate', 'Body 2', 'feat_plate'), body(6, 'post', 'Body 1', 'feat_post')]),
      generation: 3,
    };
    const listed = (b: { key: number; id: string; name: string }) => ({
      ...b,
      feature: 'feat_x',
      color: '#6699cc',
      opacity: 1,
      visible: true,
    });
    const before = {
      part: 'part_1',
      feature: 'feat_cut',
      generation: 3,
      bodies: [
        listed({ key: 2, id: 'post', name: 'Body 1' }),
        listed({ key: 5, id: 'plate', name: 'Body 2' }),
        listed({ key: 9, id: 'post2', name: 'Body 3' }),
      ],
    };
    expect(bodiesOf(preview, 'part_1', committed, before).map((b) => [b.key, b.name])).toEqual([
      [6, 'Body 1'],
      [5, 'Body 2'],
      [9, 'Body 3'],
    ]);
    // A listing from an older evaluation keeps its names; a body the shown display lacks cannot be picked.
    expect(bodiesOf({ ...preview, generation: 4 }, 'part_1', committed, before).map((b) => [b.key, b.name])).toEqual([
      [6, 'Body 1'],
      [5, 'Body 2'],
      [-1, 'Body 3'],
    ]);
    // Another part's listing does not apply.
    expect(bodiesOf(preview, 'part_1', committed, { ...before, part: 'part_2' }).map((b) => b.name)).toEqual([
      'Body 2',
    ]);
  });
});

describe('markerWhileEditing', () => {
  const row = (id: string, children: FeatureRow[] = []): FeatureRow => ({
    id,
    name: id,
    type: 'core.extrude',
    iconKey: 'extrude',
    suppressed: false,
    frozen: false,
    status: 'success',
    hidden: false,
    children,
  });
  const view = (rollbackIndex: number): PartView => ({
    id: 'part',
    name: 'Part',
    features: [row('a'), row('b'), row('comp', [row('inner')]), row('d')],
    rollbackIndex,
    groups: [],
  });

  it('sits just after the feature a panel edits, whatever the stored rollback', () => {
    expect(markerWhileEditing(view(4), 'a')).toBe(1);
    expect(markerWhileEditing(view(4), 'b')).toBe(2);
    expect(markerWhileEditing(view(1), 'd')).toBe(4);
    expect(markerWhileEditing(view(0), 'b')).toBe(2);
  });

  it('sits after the composite that holds an edited child', () => {
    expect(markerWhileEditing(view(4), 'inner')).toBe(3);
  });

  it('keeps the stored rollback with no edit, or one outside the part', () => {
    expect(markerWhileEditing(view(2), undefined)).toBe(2);
    expect(markerWhileEditing(view(2), 'feat_new')).toBe(2);
  });

  it('follows the part view of a real document', () => {
    const p = plate();
    const editor = new Editor(p.doc);
    expect(editor.dispatch({ type: 'setRollback', part: p.part, before: p.extrude }).ok).toBe(true);
    const shown = partView(editor.document, p.part, null)!;
    expect(shown.rollbackIndex).toBe(1);
    expect(markerWhileEditing(shown, p.hole)).toBe(3);
  });
});

describe('feature names and types as the interface shows them', () => {
  it('names each type in words, never by its type id, and a primitive by its shape', () => {
    expect(featureTypeLabel('core.sketch')).toBe('Sketch');
    expect(featureTypeLabel('core.loft')).toBe('Loft');
    expect(featureTypeLabel('core.sweep')).toBe('Sweep');
    expect(featureTypeLabel('core.constructionAxis')).toBe('Axis');
    expect(featureTypeLabel('core.primitive', 'cylinder')).toBe('Cylinder');
    expect(featureTypeLabel('core.someNewThing')).toBe('Some new thing');
  });

  it('keys loft, sweep and thread to their own icons', () => {
    expect(iconKeyOf({ type: 'core.loft' })).toBe('loft');
    expect(iconKeyOf({ type: 'core.sweep' })).toBe('sweep');
    expect(iconKeyOf({ type: 'core.thread' })).toBe('thread');
  });

  it('shows a feature named only by its type id, or not named, by its type', () => {
    expect(featureDisplayName({ type: 'core.sketch', name: 'core.sketch' })).toBe('Sketch');
    expect(featureDisplayName({ type: 'core.loft' })).toBe('Loft');
    expect(featureDisplayName({ type: 'core.sketch', name: 'Profile A' })).toBe('Profile A');
  });

  it('lists such a feature in the browser and timeline under that name', () => {
    const p = plate();
    (findFeature(p.doc, p.sketch) as Json).name = 'core.sketch';
    (findFeature(p.doc, p.hole) as Json).name = '';
    expect(partView(p.doc, p.part, null)?.features.map((f) => f.name)).toEqual([
      'Sketch 1',
      'Extrude 1',
      'Sketch 2',
      'Extrude 2',
    ]);
  });
});
