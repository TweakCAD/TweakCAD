import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Local edit state seeded from a value the component doesn't own.
 *
 * The pattern this replaces is everywhere in the editor's dialogs: a field
 * the user types into freely, which must re-seed when the underlying
 * document value changes out from under it (undo, a rebuild, an edit from
 * another panel). Written as an effect it looks like:
 *
 *     const [expr, setExpr] = useState(seed.expression);
 *     useEffect(() => { setExpr(seed.expression); }, [seed.expression]);
 *
 * That renders the stale value once, then re-renders with the right one —
 * a wasted pass and, for anything visible, a one-frame flash of the old
 * content. It's also what `react-hooks/set-state-in-effect` flags.
 *
 * Adjusting during render instead is react.dev's documented approach:
 * React throws away the in-progress render and retries with the new state
 * before touching the DOM, so nothing intermediate is ever painted.
 *
 * Comparison is `Object.is`, matching what a `useEffect` dependency array
 * would have done — so swapping an effect for this hook preserves the old
 * re-seed timing exactly, including for object seeds compared by identity.
 *
 * Per-field on purpose. Collapsing several fields into one composite
 * comparison would mean an external change to *any* of them discards an
 * in-progress edit to *all* the others.
 */
export function useSeededState<T>(seed: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(seed);
  const [lastSeed, setLastSeed] = useState(seed);
  if (!Object.is(seed, lastSeed)) {
    setLastSeed(seed);
    setValue(seed);
  }
  return [value, setValue];
}
