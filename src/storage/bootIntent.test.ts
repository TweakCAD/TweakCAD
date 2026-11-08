/**
 * The boot decision.
 *
 * The reported bug: three editor windows, one cloud project. Two had
 * `?project=` in the URL; the third had nothing, called "restore the most
 * recent record", and adopted the same project — then ran a third autosave
 * loop against it. The rule below is what stops that, so the case that
 * matters most here is the last one in §"never adopts".
 */

import { describe, expect, it } from 'vitest';
import { decideBoot, mayRecoverMostRecent, type BootSignals } from './bootIntent.ts';

const OFFLINE_BACKEND = { reachable: false, signedIn: false };
const SIGNED_OUT = { reachable: true, signedIn: false };
const SIGNED_IN = { reachable: true, signedIn: true };

function signals(over: Partial<BootSignals> = {}): BootSignals {
  return {
    hasProjectId: false,
    hasLocalId: false,
    saas: OFFLINE_BACKEND,
    offlineChosen: false,
    ...over,
  };
}

describe('mode', () => {
  it('is standalone when the backend does not answer', () => {
    expect(decideBoot(signals()).mode).toBe('standalone');
  });

  it('is offline when the backend answers but nobody is signed in', () => {
    expect(decideBoot(signals({ saas: SIGNED_OUT })).mode).toBe('offline');
  });

  it('is cloud when signed in', () => {
    expect(decideBoot(signals({ saas: SIGNED_IN })).mode).toBe('cloud');
  });
});

describe('a named document always wins', () => {
  // First principle: the window's document is whatever its URL says.
  // Whether it can be *loaded* is boot's problem, not this decision's.
  for (const [label, saas] of [
    ['standalone', OFFLINE_BACKEND],
    ['offline', SIGNED_OUT],
    ['cloud', SIGNED_IN],
  ] as const) {
    it(`opens a ?project= document in ${label}`, () => {
      expect(decideBoot(signals({ hasProjectId: true, saas })).kind).toBe('document');
    });
    it(`opens a ?local= document in ${label}`, () => {
      expect(decideBoot(signals({ hasLocalId: true, saas })).kind).toBe('document');
    });
  }
});

describe('nothing named', () => {
  it('standalone restores the last document — there is nowhere else it could be', () => {
    expect(decideBoot(signals())).toEqual({ kind: 'document', mode: 'standalone' });
  });

  it('signed in, it asks rather than guesses', () => {
    expect(decideBoot(signals({ saas: SIGNED_IN }))).toEqual({ kind: 'choose', mode: 'cloud' });
  });

  it('backend up and signed out, it gates first', () => {
    expect(decideBoot(signals({ saas: SIGNED_OUT }))).toEqual({ kind: 'gate', mode: 'offline' });
  });

  it('once this tab has chosen offline, it stops asking', () => {
    expect(decideBoot(signals({ saas: SIGNED_OUT, offlineChosen: true }))).toEqual({
      kind: 'document',
      mode: 'offline',
    });
  });

  it('choosing offline does not leak into a signed-in window', () => {
    // The flag is per tab. A signed-in window still chooses explicitly.
    expect(decideBoot(signals({ saas: SIGNED_IN, offlineChosen: true })).kind).toBe('choose');
  });
});

describe('never adopts another window’s document', () => {
  it('refuses recovery whenever the URL already names a document', () => {
    for (const saas of [OFFLINE_BACKEND, SIGNED_OUT, SIGNED_IN]) {
      const intent = decideBoot(signals({ hasProjectId: true, saas }));
      expect(mayRecoverMostRecent(intent, true)).toBe(false);
    }
  });

  // The reported bug, stated as a test: a signed-in window with a bare URL
  // must not reach for the most recent record, because that record can be
  // another window's cloud project mirror.
  it('refuses recovery when signed in with a bare URL', () => {
    const intent = decideBoot(signals({ saas: SIGNED_IN }));
    expect(intent.kind).toBe('choose');
    expect(mayRecoverMostRecent(intent, false)).toBe(false);
  });

  it('refuses recovery while the gate is still unanswered', () => {
    const intent = decideBoot(signals({ saas: SIGNED_OUT }));
    expect(mayRecoverMostRecent(intent, false)).toBe(false);
  });

  it('allows recovery in standalone, where there is no account to confuse it with', () => {
    const intent = decideBoot(signals());
    expect(mayRecoverMostRecent(intent, false)).toBe(true);
  });

  it('allows recovery for a tab that chose offline', () => {
    const intent = decideBoot(signals({ saas: SIGNED_OUT, offlineChosen: true }));
    expect(mayRecoverMostRecent(intent, false)).toBe(true);
  });
});
