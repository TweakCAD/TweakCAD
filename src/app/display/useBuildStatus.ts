/**
 * The status line of the build in progress, for the toolbar, and how far it
 * has come (0 to 1, or null when nothing tells): null while nothing builds.
 * It counts the seconds of a long build, so it renders again each second
 * while one runs.
 */
import { useEffect, useState } from 'react';
import { useSlice } from '../hooks';
import type { DisplayStore } from './scheduler';
import { progressShare, statusText } from './status';

export function useBuildStatus(store: DisplayStore): { text: string; share: number | null } | null {
  const evaluating = useSlice(store, (s) => s.evaluating);
  const status = useSlice(store, (s) => s.status);
  const since = useSlice(store, (s) => s.busySince);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!evaluating) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [evaluating]);
  if (!evaluating) return null;
  // The clock last ticked before this build may have started.
  return { text: statusText(status, since === null ? 0 : Math.max(0, now - since)), share: progressShare(status) };
}
