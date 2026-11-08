import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Json } from '@tweakcad/editor';
import { PickList } from './panelKit';
import { clickedProfile, type ExtrudeProfile } from './profiles';
import { readLoft, sectionProfiles, sectionsCount, withProfiles, type LoftSection } from './loft';

const row = (r: string): ExtrudeProfile => ({ sketch: 'feat_s', row: r });
const lost = (): ExtrudeProfile => ({
  kept: { entity: { id: [], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } },
});
const face: Json = { face: { entity: { id: ['a'] } } };

function ids(): () => string {
  let n = 0;
  return () => `sec_new${(n += 1)}`;
}

describe('a loft whose section is lost', () => {
  const missing = lost();
  const sections: LoftSection[] = [
    { id: 'sec_a', profile: row('a') },
    { id: 'sec_b', profile: missing },
    { id: 'sec_c', written: face },
    { id: 'sec_d', profile: row('d') },
  ];
  const click = (p: ExtrudeProfile) => withProfiles(sections, clickedProfile(sectionProfiles(sections), p), ids());

  it("puts a clicked region in the lost one's place, under its row", () => {
    const region = row('new');
    expect(click(region)).toEqual([sections[0], { id: 'sec_b', profile: region }, sections[2], sections[3]]);
  });

  it('never gives a section the panel does not offer to a click', () => {
    const noneLost: LoftSection[] = [sections[0] as LoftSection, sections[2] as LoftSection];
    const region = row('new');
    expect(withProfiles(noneLost, clickedProfile(sectionProfiles(noneLost), region), ids())).toEqual([
      ...noneLost,
      { id: 'sec_new1', profile: region },
    ]);
  });

  it('drops a section clicked again, keeping the others in order', () => {
    const [first] = sections as [{ profile: ExtrudeProfile }];
    expect(click(first.profile).map((s) => s.id)).toEqual(['sec_b', 'sec_c', 'sec_d']);
  });

  it('counts the sections found and those missing', () => {
    expect(sectionsCount(sections)).toBe('3, 1 missing');
    expect(sectionsCount(sections.filter((s) => s.id !== 'sec_b'))).toBe('3');
  });
});

describe('readLoft', () => {
  const lostRef = (lost() as { kept: Json }).kept;
  const inputs = (section: Json): Json => ({ sections: [{ id: 'sec_a', section }] });

  it('reads a profile that names no region as missing, and a face or point as written', () => {
    const doc = { parts: [{ id: 'part_1', timeline: [] }] } as unknown as Json;
    expect(readLoft(doc as never, 'part_1', inputs({ profiles: { set: [lostRef] } })).sections).toEqual([
      { id: 'sec_a', profile: { kept: lostRef } },
    ]);
    expect(readLoft(doc as never, 'part_1', inputs(face)).sections).toEqual([{ id: 'sec_a', written: face }]);
    expect(readLoft(doc as never, 'part_1', inputs({ point: { at: {} } })).sections).toEqual([
      { id: 'sec_a', written: { point: { at: {} } } },
    ]);
  });

  it('keeps a section of several regions as written, which the panel does not offer', () => {
    const doc = { parts: [{ id: 'part_1', timeline: [] }] } as unknown as Json;
    const both = { profiles: { set: [lostRef, lostRef] } };
    expect(readLoft(doc as never, 'part_1', inputs(both)).sections).toEqual([{ id: 'sec_a', written: both }]);
  });
});

describe('the list of sections', () => {
  it('heads with what it counts, and shows a missing section in red in its place', () => {
    const items = [{ label: 'Sketch 1' }, { label: 'Missing profile', missing: true }];
    const out = renderToStaticMarkup(
      PickList({ label: 'Profiles', count: '1, 1 missing', items, armed: true, onRemove: () => {}, empty: '' }),
    );
    expect(out).toContain('Profiles (1, 1 missing)');
    expect(out.indexOf('Sketch 1')).toBeLessThan(out.indexOf('Missing profile'));
    expect(out).toMatch(/color:#dc2626[^>]*>Missing profile/);
  });
});

describe('a new loft on OK', () => {
  it('hides the sketches of its sections in the same undo step, as Extrude does', async () => {
    const { Editor, seededIds } = await import('@tweakcad/editor');
    const { standardDocument } = await import('../../../lib/editor/src/testDocs');
    const { featureHidden } = await import('../attributes');
    const { findFeature } = await import('../features');
    const { ValueSlots, newTarget, writeFeature } = await import('./feature');
    const { buildLoft, newLoftForm } = await import('./loft');
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const sketch = findFeature(editor.document, ids.sketch) as Json;
    const region = (((sketch.inputs as Json).regions as Json[])[0] as Json).id as string;
    const target = newTarget(editor, ids.part, 'Loft');
    const form = {
      ...newLoftForm(false),
      sections: [
        { id: editor.newId('sec'), profile: { sketch: ids.sketch, row: region } },
        { id: editor.newId('sec'), profile: { sketch: ids.sketch, row: region } },
      ],
    };
    const built = buildLoft(editor.document, target, form, new ValueSlots(() => editor.newId('val')));
    if (!built.ok) throw new Error(built.message);
    expect(new Set(built.sketches)).toEqual(new Set([ids.sketch]));
    expect(writeFeature(editor, target, 'core.loft', built, 'Loft').ok).toBe(true);
    expect(featureHidden(editor.document, ids.part, ids.sketch)).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(featureHidden(editor.document, ids.part, ids.sketch)).toBe(false);
    expect(findFeature(editor.document, target.feature)).toBeUndefined();
  });
});
