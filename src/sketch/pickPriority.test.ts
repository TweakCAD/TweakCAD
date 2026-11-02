import { describe, it, expect } from 'vitest';
import { faceTakesPick } from './pickPriority.ts';

describe('faceTakesPick', () => {
  it('a flat face in front of a plane takes the pick', () => {
    expect(faceTakesPick({ distance: 10, flat: true }, 20)).toBe(true);
  });

  it('a curved face in front of a plane lets the plane through', () => {
    expect(faceTakesPick({ distance: 10, flat: false }, 20)).toBe(false);
  });

  it('a plane in front of a face takes the pick', () => {
    expect(faceTakesPick({ distance: 30, flat: true }, 20)).toBe(false);
  });

  it('with no plane under the cursor the face is reported, flat or not', () => {
    expect(faceTakesPick({ distance: 10, flat: false }, null)).toBe(true);
    expect(faceTakesPick({ distance: 10, flat: true }, null)).toBe(true);
  });

  it('nothing under the cursor', () => {
    expect(faceTakesPick(null, 20)).toBe(false);
    expect(faceTakesPick(null, null)).toBe(false);
  });
});
