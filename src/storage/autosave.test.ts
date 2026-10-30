/**
 * Which record a document autosaves into.
 *
 * This is the function that used to return the string `unsaved` for every
 * document that wasn't cloud-backed — one record shared by every window,
 * so two windows drawing different things overwrote each other and boot's
 * "restore the most recent record" could hand either to a third.
 */

import { describe, expect, it } from 'vitest';
import { localRecordId } from './autosave.ts';

describe('localRecordId', () => {
  it('keeps the id a stored document already has', () => {
    expect(localRecordId({ kind: 'local-stored', localId: 'doc_abc' }))
      .toEqual({ id: 'doc_abc', minted: false });
  });

  it('mirrors a cloud document under its project id', () => {
    expect(localRecordId({ kind: 'cloud', cloudProjectId: 'proj_1', localId: 'ignored' }))
      .toEqual({ id: 'cloud-mirror-proj_1', minted: false });
  });

  it('mints an identity for a document that has none', () => {
    expect(localRecordId({ kind: 'local-fresh' }, () => 'doc_new'))
      .toEqual({ id: 'doc_new', minted: true });
  });

  it('gives two fresh documents different records', () => {
    // The regression: both used to be the single `unsaved` slot, so the
    // second window's first save destroyed the first window's document.
    let n = 0;
    const mint = () => `doc_${++n}`;
    const first = localRecordId({ kind: 'local-fresh' }, mint);
    const second = localRecordId({ kind: 'local-fresh' }, mint);
    expect(first.id).not.toBe(second.id);
  });

  it('only reports `minted` when it actually invented one', () => {
    // `minted` drives the URL rewrite. Reporting it for a document that
    // already had an id would rewrite the address bar on every autosave.
    expect(localRecordId({ kind: 'local-stored', localId: 'doc_abc' }).minted).toBe(false);
    expect(localRecordId({ kind: 'cloud', cloudProjectId: 'p', localId: 'x' }).minted).toBe(false);
  });

  it('never returns the old shared slot', () => {
    const ids = [
      localRecordId({ kind: 'local-fresh' }).id,
      localRecordId({ kind: 'local-stored', localId: 'doc_abc' }).id,
      localRecordId({ kind: 'cloud', cloudProjectId: 'p', localId: 'x' }).id,
    ];
    expect(ids).not.toContain('unsaved');
  });
});
