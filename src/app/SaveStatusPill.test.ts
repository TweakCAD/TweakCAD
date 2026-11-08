import { describe as suite, expect, it } from 'vitest';
import { describe } from './SaveStatusPill';

suite('save status', () => {
  it('says what autosave is doing, for each place the document lives', () => {
    const unsaved = { kind: 'unsaved' } as const;
    const disk = { kind: 'disk', handle: null, filename: 'plate.cadjson' } as const;
    const cloud = { kind: 'cloud', projectId: 'p1', name: 'Plate' } as const;
    expect(describe({ kind: 'idle' }, unsaved)).toBe('no changes');
    expect(describe({ kind: 'idle' }, disk)).toBe('no changes');
    expect(describe({ kind: 'idle' }, cloud)).toBe('saved');
    expect(describe({ kind: 'saving' }, cloud)).toBe('saving...');
    expect(describe({ kind: 'saved', at: 1 }, disk)).toBe('saved in this browser');
    expect(describe({ kind: 'saved', at: 1 }, cloud)).toBe('saved');
    expect(describe({ kind: 'offline', queued: 2 }, cloud)).toBe('offline (2 queued)');
    expect(describe({ kind: 'conflict', message: 'moved' }, cloud)).toBe('changed elsewhere, reload before saving');
    expect(describe({ kind: 'error', message: 'quota' }, disk)).toBe('error: quota');
  });
});
