/**
 * The return path for a social sign-in round trip.
 *
 * Email/password sign-in never navigates, so this only matters for a
 * provider redirect — which is a full page load, after which the editor
 * reboots from the URL alone. Anything the URL doesn't carry is gone, and
 * what the URL carries is *which document this window had open*.
 *
 * Returning only `pathname` is what shipped: signing in with Google from an
 * open cloud project landed the user back in an empty editor with the
 * project silently unbound.
 */

import { describe, expect, it } from 'vitest';
import { returnPath } from './SignInModal.tsx';

describe('returnPath', () => {
  it('keeps the project id across the round trip', () => {
    expect(returnPath({ pathname: '/cad', search: '?project=proj_abc123' }))
      .toBe('/cad?project=proj_abc123');
  });

  it('keeps a local document id too', () => {
    expect(returnPath({ pathname: '/cad', search: '?local=doc_42' }))
      .toBe('/cad?local=doc_42');
  });

  it('keeps every parameter, not just the first', () => {
    expect(returnPath({ pathname: '/cad', search: '?project=p1&panel=history' }))
      .toBe('/cad?project=p1&panel=history');
  });

  it('is unchanged when there is no query string', () => {
    expect(returnPath({ pathname: '/cad', search: '' })).toBe('/cad');
  });

  it('stays a path — never an absolute URL', () => {
    const out = returnPath({ pathname: '/cad', search: '?project=p1' });
    expect(out.startsWith('/')).toBe(true);
    expect(out).not.toMatch(/^[a-z]+:/i);
    expect(out).not.toMatch(/^\/\//);
  });
});

/**
 * Open redirect.
 *
 * `location.pathname` is attacker-influenceable: send someone to
 * `https://tweakcad.com//evil.com/cad` and the browser reports
 * `//evil.com/cad`. Passed on unchanged that is a protocol-relative URL and
 * the post-sign-in redirect leaves the origin — handing an attacker a
 * landing page that arrives straight out of an authentication flow, which
 * is where a user is least likely to question it.
 */
describe('returnPath cannot leave the origin', () => {
  const ESCAPES = [
    ['protocol-relative', '//evil.com/cad'],
    ['protocol-relative, many slashes', '////evil.com/cad'],
    ['backslash-relative', '\\\\evil.com/cad'],
    ['mixed slash and backslash', '/\\evil.com/cad'],
    ['backslash then slash', '\\/evil.com/cad'],
  ];

  for (const [label, pathname] of ESCAPES) {
    it(`neutralises ${label}`, () => {
      const out = returnPath({ pathname, search: '' });
      // Single-slash-rooted: the only shape that can only ever mean "a path
      // on this origin".
      expect(out.startsWith('/')).toBe(true);
      expect(out.startsWith('//')).toBe(false);
      expect(out.startsWith('/\\')).toBe(false);
      // And the host it was trying to reach is no longer a host.
      expect(new URL(out, 'https://tweakcad.com').origin).toBe('https://tweakcad.com');
    });
  }

  it('resolves to this origin for every shape, including a query string', () => {
    for (const [, pathname] of ESCAPES) {
      const out = returnPath({ pathname, search: '?project=p1' });
      expect(new URL(out, 'https://tweakcad.com').origin).toBe('https://tweakcad.com');
    }
  });

  it('leaves an ordinary path untouched', () => {
    // The guard must not mangle the normal case it exists to protect.
    expect(returnPath({ pathname: '/cad', search: '?local=doc_1' }))
      .toBe('/cad?local=doc_1');
    expect(returnPath({ pathname: '/', search: '' })).toBe('/');
  });
});
