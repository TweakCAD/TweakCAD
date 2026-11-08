/**
 * Default project names.
 *
 * Two things are worth pinning: the shape (so callers can rely on it), and
 * the word lists against the rules that justify them. The lists are the
 * part that will drift — someone adds a word that seems fine and reintroduces
 * exactly the problem the generated name was meant to avoid.
 */

import { describe, expect, it } from 'vitest';
import { generateProjectName, unusedProjectName, WORD_LISTS } from './projectName.ts';

describe('unusedProjectName', () => {
  it('draws again while the name is taken, whatever its case, and gives up after a few tries', () => {
    const draws = [0, 0, 0.5];
    const random = () => draws.shift() ?? 0.5;
    const first = generateProjectName(() => 0);
    const third = generateProjectName(() => 0.5);
    expect(unusedProjectName([` ${first.toUpperCase()} `], random)).toBe(third);
    expect(unusedProjectName([first], () => 0)).toBe(first);
  });
});

describe('generateProjectName', () => {
  it('is two lowercase words joined by a hyphen', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateProjectName()).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });

  it('is deterministic given a deterministic source', () => {
    const always = () => 0;
    expect(generateProjectName(always)).toBe(generateProjectName(always));
  });

  it('draws from both lists rather than one', () => {
    const [adj, noun] = generateProjectName(() => 0).split('-');
    expect(WORD_LISTS.ADJECTIVES).toContain(adj);
    expect(WORD_LISTS.NOUNS).toContain(noun);
  });

  it('reaches the end of each list', () => {
    // `Math.floor(0.999… * n)` is the last index — a generator that can't
    // reach it would quietly halve the namespace.
    const last = generateProjectName(() => 0.999999);
    const [adj, noun] = last.split('-');
    expect(adj).toBe(WORD_LISTS.ADJECTIVES.at(-1));
    expect(noun).toBe(WORD_LISTS.NOUNS.at(-1));
  });

  it('offers enough combinations to make a repeat unlikely', () => {
    const pairs = WORD_LISTS.ADJECTIVES.length * WORD_LISTS.NOUNS.length;
    expect(pairs).toBeGreaterThan(2000);
  });
});

describe('word lists obey their own rules', () => {
  const all = [...WORD_LISTS.ADJECTIVES, ...WORD_LISTS.NOUNS];

  it('are lowercase single words — no proper nouns, no spaces', () => {
    for (const w of all) expect(w).toMatch(/^[a-z]+$/);
  });

  it('have no duplicates within a list', () => {
    expect(new Set(WORD_LISTS.ADJECTIVES).size).toBe(WORD_LISTS.ADJECTIVES.length);
    expect(new Set(WORD_LISTS.NOUNS).size).toBe(WORD_LISTS.NOUNS.length);
  });

  // The rule that matters most: a name must never read as a claim about
  // what the model contains, or a user sees `steel-flange` and reasonably
  // assumes the document holds a flange.
  it('contain no mechanical part vocabulary', () => {
    const PARTS = [
      'bolt',
      'nut',
      'screw',
      'washer',
      'flange',
      'gear',
      'shaft',
      'bearing',
      'bracket',
      'plate',
      'hinge',
      'spring',
      'gasket',
      'pulley',
      'sprocket',
      'rivet',
      'pin',
      'clamp',
      'coupling',
      'valve',
      'piston',
      'cam',
      'spline',
    ];
    for (const part of PARTS) expect(all).not.toContain(part);
  });

  it('contain no material names that imply what it is made of', () => {
    // `steel-ridge` reads as a steel part. Colours that happen to be metals
    // (amber, bronze, copper) are accepted as colours; raw stock names are not.
    for (const m of ['steel', 'aluminium', 'aluminum', 'titanium', 'plastic', 'resin']) {
      expect(all).not.toContain(m);
    }
  });
});
