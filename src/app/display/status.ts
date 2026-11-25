/**
 * The status line of a build: what the worker is doing now, as its progress
 * reports it, or what an import is doing, and since when the app has been
 * busy. Counts are work items (features, bodies, sketches), not time.
 */
import type { Progress } from '@tweakcad/worker/src/v2/service/types';

export interface BuildStatus {
  /** What is being done: "Building Extrude 12", "Meshing bodies". */
  label: string;
  /** Item `done + 1` of `total` is under way. */
  done?: number;
  total?: number;
  /** How far the whole build has come in time (0 to 1), when the worker can tell. */
  fraction?: number;
  /** The stage under way, for a share of the build without `fraction`. */
  stage?: 'building' | 'placing' | 'meshing';
}

/** Building's share of a build told by counts alone; placing and meshing take the rest. */
const BUILDING_SHARE = 0.9;

const TYPE_LABEL = (type: string) => {
  const bare = type.replace(/^core\./, '');
  return bare.charAt(0).toUpperCase() + bare.slice(1);
};

/** The status a worker's progress shows; null for progress that changes no status (a part built early). */
export function statusOf(p: Progress): BuildStatus | null {
  switch (p.phase) {
    case 'built':
      return null;
    case 'reading':
      return { label: 'Reading the document' };
    case 'building':
      return {
        label: `Building ${p.name || TYPE_LABEL(p.type)}`,
        done: p.done,
        total: p.total,
        stage: 'building',
        ...(p.fraction !== undefined ? { fraction: p.fraction } : {}),
      };
    case 'placing':
      return {
        label: 'Placing parts',
        stage: 'placing',
        ...(p.fraction !== undefined ? { fraction: p.fraction } : {}),
      };
    case 'meshing':
      return {
        label: 'Meshing bodies',
        done: p.done,
        total: p.total,
        stage: 'meshing',
        ...(p.fraction !== undefined ? { fraction: p.fraction } : {}),
      };
  }
}

/**
 * How far the build has come, 0 to 1: the worker's `fraction` when it can
 * tell one, otherwise the counts, building taking most of the way and
 * meshing the rest; null when nothing tells (work that reports no counts).
 */
export function progressShare(status: BuildStatus | null): number | null {
  if (!status) return null;
  if (status.fraction !== undefined) return status.fraction;
  const share = status.total ? Math.min(1, (status.done ?? 0) / status.total) : undefined;
  if (status.stage === 'building' && share !== undefined) return BUILDING_SHARE * share;
  if (status.stage === 'placing') return BUILDING_SHARE;
  if (status.stage === 'meshing') return BUILDING_SHARE + (1 - BUILDING_SHARE) * (share ?? 0);
  return share ?? null;
}

/** The status line: "Building Extrude 12 (34 of 210)", with the seconds spent once a build has taken a while. */
export function statusText(status: BuildStatus | null, elapsedMs = 0): string {
  const label = status?.label ?? 'Rebuilding';
  const count =
    status?.total !== undefined && status.done !== undefined && status.total > 0
      ? ` (${Math.min(status.done + 1, status.total)} of ${status.total})`
      : '';
  const seconds = elapsedMs >= 2000 ? ` · ${Math.floor(elapsedMs / 1000)} s` : '';
  return `${label}${count}${seconds}`;
}
