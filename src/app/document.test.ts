import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, loadDocument, randomIds, seededIds } from '@tweakcad/editor';
import { formatTime, newDocument, WRITER } from './document';

describe('newDocument', () => {
  it('reads clean, with no diagnostics at all', () => {
    const doc = newDocument({ ids: randomIds(), name: 'quiet-ratchet' });
    expect(readDocument(doc).diagnostics).toEqual([]);
  });

  it('holds one part named Part 1, which is the root', () => {
    const doc = newDocument({ ids: seededIds(1), name: 'n' });
    const parts = doc.parts as { id: string; name: string }[];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.name).toBe('Part 1');
    expect(doc.root).toEqual({ part: { id: parts[0]?.id } });
  });

  it('names this app as its writer', () => {
    const doc = newDocument({ ids: randomIds(), name: 'n' });
    expect((doc.metadata as { writer: unknown }).writer).toEqual({ app: 'TweakCAD', version: WRITER.version });
  });

  it('stamps both times to the second', () => {
    const doc = newDocument({ ids: randomIds(), name: 'n', now: new Date('2026-11-06T10:20:30.456Z') });
    const metadata = doc.metadata as { createdAt: string; updatedAt: string };
    expect(metadata.createdAt).toBe('2026-11-06T10:20:30Z');
    expect(metadata.updatedAt).toBe(metadata.createdAt);
    expect(formatTime(new Date(0))).toBe('1970-01-01T00:00:00Z');
  });

  it('is held by an editor and survives a save and load byte for byte', () => {
    const editor = new Editor(newDocument({ ids: randomIds(), name: 'n' }), { ids: randomIds() });
    const text = editor.save();
    const loaded = loadDocument(text);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(new Editor(loaded.document).save()).toBe(text);
  });
});
