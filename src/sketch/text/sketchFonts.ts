/**
 * Fonts bundled for the sketch Text tool, and their loader.
 *
 * All three are static (non-variable) TTFs under the SIL Open Font License
 * (licence texts next to the files in src/assets/fonts). Static instances
 * matter: variable fonts keep overlapping contours, which would become
 * crossing loops in a sketch. Each font is fetched and parsed on first use
 * and cached for the session; the parser itself is loaded on first use too.
 */

import type { Font } from 'opentype.js';
import lilitaOneUrl from '../../assets/fonts/LilitaOne-Regular.ttf?url';
import bebasNeueUrl from '../../assets/fonts/BebasNeue-Regular.ttf?url';
import atkinsonBoldUrl from '../../assets/fonts/AtkinsonHyperlegible-Bold.ttf?url';

export type SketchFontId = 'lilita-one' | 'bebas-neue' | 'atkinson-bold';

export interface SketchFontDef {
  id: SketchFontId;
  label: string;
  /** File name under src/assets/fonts. */
  file: string;
  url: string;
}

export const SKETCH_FONTS: readonly SketchFontDef[] = [
  { id: 'lilita-one', label: 'Lilita One', file: 'LilitaOne-Regular.ttf', url: lilitaOneUrl },
  { id: 'bebas-neue', label: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', url: bebasNeueUrl },
  {
    id: 'atkinson-bold',
    label: 'Atkinson Hyperlegible Bold',
    file: 'AtkinsonHyperlegible-Bold.ttf',
    url: atkinsonBoldUrl,
  },
];

export const DEFAULT_SKETCH_FONT: SketchFontId = 'lilita-one';

const cache = new Map<SketchFontId, Promise<Font>>();

/** Fetch + parse a bundled font (cached). Rejects if the file can't be loaded. */
export function loadSketchFont(id: SketchFontId): Promise<Font> {
  let pending = cache.get(id);
  if (!pending) {
    const def = SKETCH_FONTS.find((f) => f.id === id);
    if (!def) return Promise.reject(new Error(`Unknown font: ${id}`));
    pending = fetch(def.url)
      .then((res) => {
        if (!res.ok) throw new Error(`Font ${def.label} failed to load (${res.status})`);
        return res.arrayBuffer();
      })
      .then(async (buf) => (await import('opentype.js')).parse(buf));
    // A failed load is not cached, so the next use retries.
    pending.catch(() => cache.delete(id));
    cache.set(id, pending);
  }
  return pending;
}
