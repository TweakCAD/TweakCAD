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
    // Better Auth resolves callbackURL against its own baseURL. Returning
    // something with a scheme or a host would be an open-redirect hole.
    const out = returnPath({ pathname: '/cad', search: '?project=p1' });
    expect(out.startsWith('/')).toBe(true);
    expect(out).not.toMatch(/^[a-z]+:/i);
    expect(out).not.toMatch(/^\/\//);
  });
});
