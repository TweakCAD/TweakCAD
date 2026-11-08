import { describe, expect, it } from 'vitest';
import { applyPatch, diffDocs } from './docPatch';

describe('document patches', () => {
  const base = () => {
    const shared = { id: 'feat_b', inputs: { d: '10 mm' } };
    return {
      doc: {
        name: 'a',
        parts: [{ id: 'part_1', timeline: [{ id: 'feat_a', inputs: { d: '5 mm' } }, shared], rollback: { end: {} } }],
        assets: { big: { data: 'x'.repeat(1000) } },
      },
      shared,
    };
  };

  it('finds only the changed places and rebuilds the next document from the one before, sharing what did not change', () => {
    const { doc, shared } = base();
    const timeline = doc.parts[0]!.timeline;
    const next = {
      ...doc,
      parts: [
        {
          ...doc.parts[0]!,
          timeline: [{ ...timeline[0]!, inputs: { d: '6 mm' } }, shared],
          rollback: { before: { id: 'feat_b' } },
        },
      ],
    };
    const patch = diffDocs(doc, next);
    expect(patch).toEqual([
      { path: ['parts', 0, 'timeline', 0, 'inputs', 'd'], value: '6 mm' },
      { path: ['parts', 0, 'rollback', 'before'], value: { id: 'feat_b' } },
      { path: ['parts', 0, 'rollback', 'end'], deleted: true },
    ]);
    const kept = structuredClone(doc);
    const built = applyPatch(kept, patch) as typeof doc;
    expect(built).toEqual(next);
    // The one before is as it was; what the change left alone is the same object.
    expect(kept).toEqual(doc);
    expect(built.assets).toBe(kept.assets);
    expect(built.parts[0]!.timeline[1]).toBe(kept.parts[0]!.timeline[1]);
    expect(built.parts[0]!.timeline[0]).not.toBe(kept.parts[0]!.timeline[0]);
  });

  it('sends a list whose length changed whole, and nothing for equal documents', () => {
    const { doc } = base();
    const grown = {
      ...doc,
      parts: [{ ...doc.parts[0]!, timeline: [...doc.parts[0]!.timeline, { id: 'feat_c', inputs: { d: '1 mm' } }] }],
    };
    const patch = diffDocs(doc, grown);
    expect(patch).toEqual([{ path: ['parts', 0, 'timeline'], value: grown.parts[0]!.timeline }]);
    expect(applyPatch(structuredClone(doc), patch)).toEqual(grown);
    expect(diffDocs(doc, structuredClone(doc))).toEqual([]);
    expect(applyPatch(doc, [])).toBe(doc);
  });
});
