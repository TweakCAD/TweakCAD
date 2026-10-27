/**
 * The gate that keeps a standalone build standalone.
 *
 * The CAD app ships two ways: served by the SaaS layer, and as an offline
 * image with no backend at all. In the second case SaaS features must be
 * *absent*, not merely broken — a catalog button that can only ever produce
 * a network error is worse than no button, and that is exactly what shipped
 * until this gate was applied to the components panel.
 *
 * These pin the two distinctions the UI depends on: reachable-vs-not, and
 * reachable-but-signed-out (where public surfaces still work).
 */
import { describe, expect, it } from 'vitest';
import { isSaasAvailable, isSignedIn } from './saasState.ts';
import type { SaasState } from './saasState.ts';

const UNKNOWN: SaasState = { kind: 'unknown' };
const UNAVAILABLE: SaasState = { kind: 'unavailable', reason: 'ECONNREFUSED' };
const SIGNED_OUT: SaasState = { kind: 'available', signedIn: false };
const SIGNED_IN: SaasState = {
  kind: 'available',
  signedIn: true,
  user: { id: 'u1', email: 'a@b.c', name: 'A', image: null },
};

describe('isSaasAvailable', () => {
  it('is false with no backend', () => {
    expect(isSaasAvailable(UNAVAILABLE)).toBe(false);
  });

  it('is false before the probe resolves', () => {
    // The window between boot and the probe returning. Showing a SaaS button
    // optimistically and retracting it a moment later is its own bug.
    expect(isSaasAvailable(UNKNOWN)).toBe(false);
  });

  it('is false when the UI has no state yet', () => {
    // Several components take `saas` as optional; this accepting undefined is
    // what keeps `saas && isSaasAvailable(saas)` out of every call site.
    expect(isSaasAvailable(undefined)).toBe(false);
  });

  it('is true when signed out, because the catalog is public', () => {
    // Deliberately not `signedIn`: browsing and inserting a published
    // component needs a backend, not an account.
    expect(isSaasAvailable(SIGNED_OUT)).toBe(true);
  });

  it('is true when signed in', () => {
    expect(isSaasAvailable(SIGNED_IN)).toBe(true);
  });
});

describe('isSignedIn', () => {
  it('separates "backend present" from "has an account"', () => {
    // Cloud save needs the second; the catalog only needs the first.
    expect(isSignedIn(SIGNED_OUT)).toBe(false);
    expect(isSignedIn(SIGNED_IN)).toBe(true);
  });

  it('is false for every non-available state', () => {
    expect(isSignedIn(UNKNOWN)).toBe(false);
    expect(isSignedIn(UNAVAILABLE)).toBe(false);
  });

  it('narrows to the user-bearing variant', () => {
    // The type guard is what lets call sites read `saas.user` without a cast.
    if (isSignedIn(SIGNED_IN)) {
      expect(SIGNED_IN.user.email).toBe('a@b.c');
    } else {
      throw new Error('expected the guard to narrow');
    }
  });
});
