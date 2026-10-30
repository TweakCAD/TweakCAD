/**
 * Local-document identity in the URL.
 *
 * Before this, every window without a `?project=` wrote to one IndexedDB
 * record called `unsaved`, and boot recovered by taking "the most recent
 * record" — so two windows overwrote each other, and a third could adopt
 * either one's document. The id in the URL is what makes a window's
 * document *its* document, across reloads and across the full page load at
 * the end of a social sign-in.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { localIdFromUrl, newLocalId, rememberLocalIdInUrl } from './context.ts';

/** Minimal `window` stand-in: a location and a history that records writes. */
function fakeWindow(href: string) {
  const replaced: string[] = [];
  return {
    replaced,
    win: {
      location: { href, search: new URL(href).search },
      history: {
        state: null,
        replaceState: (_s: unknown, _t: string, url: string) => {
          replaced.push(url);
        },
      },
    },
  };
}

const realWindow = globalThis.window;
afterEach(() => {
  if (realWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else (globalThis as { window?: unknown }).window = realWindow;
});

function install(href: string) {
  const f = fakeWindow(href);
  (globalThis as { window?: unknown }).window = f.win;
  return f;
}

describe('localIdFromUrl', () => {
  it('reads the id a window was opened with', () => {
    install('https://tweakcad.com/cad?local=doc_abc');
    expect(localIdFromUrl()).toBe('doc_abc');
  });

  it('is null when the window names no document', () => {
    install('https://tweakcad.com/cad');
    expect(localIdFromUrl()).toBeNull();
  });

  it('ignores a cloud project id — different parameter, different meaning', () => {
    install('https://tweakcad.com/cad?project=proj_1');
    expect(localIdFromUrl()).toBeNull();
  });
});

describe('newLocalId', () => {
  it('does not collide across rapid calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newLocalId()));
    expect(ids.size).toBe(500);
  });

  it('is URL-safe, so it survives the round trip it exists for', () => {
    for (let i = 0; i < 50; i++) {
      const id = newLocalId();
      expect(id).toBe(encodeURIComponent(id));
    }
  });
});

describe('rememberLocalIdInUrl', () => {
  it('adds the id without navigating', () => {
    const f = install('https://tweakcad.com/cad');
    rememberLocalIdInUrl('doc_abc');
    expect(f.replaced).toHaveLength(1);
    expect(new URL(f.replaced[0]!).searchParams.get('local')).toBe('doc_abc');
  });

  it('keeps other parameters', () => {
    const f = install('https://tweakcad.com/cad?panel=history');
    rememberLocalIdInUrl('doc_abc');
    const url = new URL(f.replaced[0]!);
    expect(url.searchParams.get('panel')).toBe('history');
    expect(url.searchParams.get('local')).toBe('doc_abc');
  });

  it('does nothing when the id is already there', () => {
    // Autosave calls this on a write; rewriting an unchanged URL every two
    // seconds would churn history for no reason.
    const f = install('https://tweakcad.com/cad?local=doc_abc');
    rememberLocalIdInUrl('doc_abc');
    expect(f.replaced).toHaveLength(0);
  });

  it('survives a history API that refuses', () => {
    const f = install('https://tweakcad.com/cad');
    f.win.history.replaceState = () => { throw new Error('blocked'); };
    expect(() => rememberLocalIdInUrl('doc_abc')).not.toThrow();
  });

  it('is a no-op without a window', () => {
    Reflect.deleteProperty(globalThis, 'window');
    expect(() => rememberLocalIdInUrl('doc_abc')).not.toThrow();
    expect(localIdFromUrl()).toBeNull();
  });
});
