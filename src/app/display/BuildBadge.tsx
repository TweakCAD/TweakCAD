/**
 * The toolbar's red badge while a build runs, with what it is doing. It reads
 * the display store itself, so only the badge renders as the build goes, not
 * the app around it.
 */
import { RebuildBadge } from '../../components/MainToolbar.tsx';
import type { DisplayStore } from './scheduler';
import { useBuildStatus } from './useBuildStatus';

export function BuildBadge({ store }: { store: DisplayStore }) {
  const text = useBuildStatus(store);
  return text === null ? null : <RebuildBadge text={text} />;
}
