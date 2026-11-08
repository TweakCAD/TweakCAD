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
}

const TYPE_LABEL = (type: string) => {
  const bare = type.replace(/^core\./, '');
  return bare.charAt(0).toUpperCase() + bare.slice(1);
};

/** The status a worker's progress shows. */
export function statusOf(p: Progress): BuildStatus {
  switch (p.phase) {
    case 'reading':
      return { label: 'Reading the document' };
    case 'building':
      return { label: `Building ${p.name || TYPE_LABEL(p.type)}`, done: p.done, total: p.total };
    case 'placing':
      return { label: 'Placing parts' };
    case 'meshing':
      return { label: 'Meshing bodies', done: p.done, total: p.total };
  }
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
