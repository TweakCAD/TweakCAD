/**
 * How long each stage of a document's last build took (`BuildTimes`), kept
 * in the browser's local storage by document id, so the next build of the
 * document, after a reload as well, can show how far it has come in time.
 * Only the most recent documents are kept.
 */
import type { BuildTimes } from '@tweakcad/worker/src/v2/service/types';

export interface BuildTimesStore {
  get(id: string): BuildTimes | undefined;
  set(id: string, times: BuildTimes): void;
}

const PREFIX = 'tweakcad.buildTimes.';
const INDEX = `${PREFIX}index`;
/** Documents whose times are kept. */
const KEEP = 30;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export const localBuildTimes: BuildTimesStore = {
  get(id) {
    const s = storage();
    const text = s?.getItem(PREFIX + id);
    if (!text) return undefined;
    try {
      const times = JSON.parse(text) as BuildTimes;
      return times && typeof times.features === 'object' ? times : undefined;
    } catch {
      return undefined;
    }
  },
  set(id, times) {
    const s = storage();
    if (!s) return;
    try {
      const index = (JSON.parse(s.getItem(INDEX) ?? '[]') as string[]).filter((d) => d !== id);
      index.unshift(id);
      for (const old of index.splice(KEEP)) s.removeItem(PREFIX + old);
      s.setItem(PREFIX + id, JSON.stringify(times));
      s.setItem(INDEX, JSON.stringify(index));
    } catch {
      // Storage full or refused: the next build counts features instead.
    }
  },
};
