/**
 * Default names for a project nobody has named yet.
 *
 * `'New Project'` was minted in two places and read as a *button* rather than
 * a name — it sits in the app bar next to actual buttons, so "New Project"
 * looks like something you click to make one.
 *
 * A generated two-word name fixes that and buys something else: in a list of
 * twenty, `quiet-ratchet` and `copper-lantern` are distinguishable at a
 * glance in a way `New Project (2)` and `New Project (3)` are not. You can
 * say one out loud to a colleague; you cannot say "the third New Project".
 *
 * **Word choice rules**, because the obvious lists get this wrong:
 *
 *  - Nothing that could read as a description of the model. `bronze-bracket`
 *    implies the contents *are* a bracket, and it won't be.
 *  - Nothing from part vocabulary at all (bolt, flange, gear, shaft) — it
 *    would collide with real searches later.
 *  - Tame and mechanical. This is a CAD tool, not a pet-name generator; no
 *    jokes, nothing anyone would be embarrassed to screen-share.
 *  - No proper nouns, no people. Docker's scientist surnames read oddly as
 *    project names, and names carry associations we don't control.
 *
 * Lists are vendored rather than pulled from a package: two string arrays
 * are not worth a dependency, and every public list needs this filtering
 * pass anyway. 64 × 64 = 4096 pairs, which is plenty for one person's
 * projects — this is a placeholder to be renamed, not an identifier.
 */

/** The name of a new document kept in this browser or saved to disk, until it is named: like a desktop program's. */
export const UNTITLED = 'Untitled';

/**
 * A generated name none of `taken` has, for a new cloud project: a few
 * tries, then any. The account's names are compared case-blind.
 */
export function unusedProjectName(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  let name = generateProjectName(random);
  for (let i = 0; i < 20 && used.has(name); i++) name = generateProjectName(random);
  return name;
}

/** Neutral adjectives: material, colour, texture, temperament. */
const ADJECTIVES = [
  'amber',
  'ample',
  'arctic',
  'bright',
  'bronze',
  'calm',
  'candid',
  'civic',
  'clear',
  'cobalt',
  'copper',
  'crisp',
  'curious',
  'dapper',
  'deft',
  'dusty',
  'eager',
  'early',
  'easy',
  'even',
  'fair',
  'fleet',
  'fond',
  'frank',
  'gentle',
  'glad',
  'golden',
  'graceful',
  'granite',
  'hearty',
  'humble',
  'ivory',
  'jade',
  'keen',
  'level',
  'lively',
  'lucid',
  'lunar',
  'marble',
  'mellow',
  'merry',
  'mild',
  'modest',
  'neat',
  'nimble',
  'noble',
  'olive',
  'patient',
  'placid',
  'plain',
  'polar',
  'prime',
  'quiet',
  'rapid',
  'ready',
  'russet',
  'scarlet',
  'serene',
  'silver',
  'solar',
  'steady',
  'sunny',
  'tidy',
  'violet',
];

/**
 * Nouns from landscape, weather, time and craft — never from mechanical
 * parts, so a name can't be mistaken for a description of the geometry.
 */
const NOUNS = [
  'anchor',
  'atlas',
  'basin',
  'beacon',
  'bramble',
  'canyon',
  'cedar',
  'cinder',
  'clover',
  'comet',
  'cove',
  'current',
  'dawn',
  'delta',
  'dune',
  'ember',
  'estuary',
  'fathom',
  'fern',
  'fjord',
  'foundry',
  'garden',
  'glacier',
  'glade',
  'harbor',
  'harvest',
  'heath',
  'horizon',
  'island',
  'junction',
  'kiln',
  'lagoon',
  'lantern',
  'ledger',
  'lighthouse',
  'meadow',
  'meridian',
  'mesa',
  'morning',
  'orchard',
  'pasture',
  'pebble',
  'pier',
  'prairie',
  'quarry',
  'quill',
  'ridge',
  'river',
  'sandbar',
  'sequoia',
  'signal',
  'solstice',
  'summit',
  'thicket',
  'tide',
  'timber',
  'trellis',
  'tundra',
  'valley',
  'vantage',
  'vista',
  'willow',
  'windmill',
  'zenith',
];

function pick<T>(list: readonly T[], random: () => number): T {
  return list[Math.floor(random() * list.length)]!;
}

/**
 * A fresh default project name, e.g. `copper-lantern`.
 *
 * `random` is injectable so tests can pin the output; production callers
 * pass nothing and get `Math.random`. Collisions are fine and expected —
 * this names a document, it does not identify one. Identity is the id in
 * the URL.
 */
export function generateProjectName(random: () => number = Math.random): string {
  return `${pick(ADJECTIVES, random)}-${pick(NOUNS, random)}`;
}

/** Exposed for the test that guards the word lists against their own rules. */
export const WORD_LISTS = { ADJECTIVES, NOUNS } as const;
