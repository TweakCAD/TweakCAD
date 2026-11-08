/**
 * One-click placement of an imported body, from its body menu:
 * Move to origin centres the import's bounds on the origin, Drop on XY
 * plane keeps X and Y and puts its lowest point on Z = 0. Every body the
 * import made moves together, so a multi-body import keeps its own
 * arrangement. The placement is a new Move feature at the rollback marker,
 * one undo step; the import itself stays as the file had it.
 */
import type { Display, Key } from '@tweakcad/worker/src/v2/service/types';
import { consoleLog } from '../console';
import type { AppServices } from '../services';
import { ValueSlots, newTarget, writeFeature, type PickedRef } from './feature';
import { buildMove, newMoveForm } from './bodyFeatures';
import { pickFor } from './picks';
import type { Outcome } from './commands';

export type PlaceTo = 'origin' | 'xy';

type Box = { min: [number, number, number]; max: [number, number, number] };

/** The bodies of `part` that the feature which made body `key` made, with their bounds; null when none is shown. */
export function importBodies(display: Display | null, part: string, key: Key): { keys: Key[]; box: Box } | null {
  const index = display?.parts[part];
  const definition = index === undefined ? undefined : display?.definitions[index];
  const body = definition?.bodies.find((b) => b.key === key);
  if (!definition || !body) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const keys: Key[] = [];
  for (const b of definition.bodies) {
    if (b.feature !== body.feature) continue;
    keys.push(b.key);
    const p = b.mesh.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p[i + k] as number;
        if (v < (min[k] as number)) min[k] = v;
        if (v > (max[k] as number)) max[k] = v;
      }
    }
  }
  return keys.length > 0 && min[0] <= max[0] ? { keys, box: { min, max } } : null;
}

const round = (n: number): number => Math.round(n * 1000) / 1000 + 0;

/** The translation that places `box`: its centre to the origin, or its bottom onto Z = 0. */
export function placementDelta(box: Box, to: PlaceTo): [number, number, number] {
  if (to === 'xy') return [0, 0, round(-box.min[2])];
  return [0, 1, 2].map((k) => round(-((box.min[k] as number) + (box.max[k] as number)) / 2)) as [
    number,
    number,
    number,
  ];
}

/** Places the import that made body `key` of `part`, as a Move feature. */
export async function placeImported(services: AppServices, part: string, key: Key, to: PlaceTo): Promise<Outcome> {
  const { editor, display } = services;
  const found = importBodies(display.getState().display, part, key);
  if (!found) return { ok: false, message: 'The body is not shown' };
  const delta = placementDelta(found.box, to);
  if (delta.every((d) => d === 0)) {
    consoleLog(
      'info',
      to === 'origin' ? 'The import is at the origin already' : 'The import rests on the XY plane already',
      'move',
    );
    return { ok: true };
  }
  const target = newTarget(editor, part, 'Move');
  const bodies: PickedRef[] = [];
  for (const k of found.keys) {
    const picked = await pickFor(services, target, { key: k }, 'Body');
    if (!picked) return { ok: false, message: 'The body is no longer shown; try again' };
    bodies.push(picked);
  }
  const form = { ...newMoveForm(), bodies, x: String(delta[0]), y: String(delta[1]), z: String(delta[2]) };
  const built = buildMove(editor.document, target, form, new ValueSlots(() => editor.newId('val')));
  if (!built.ok) return { ok: false, message: built.message };
  const written = writeFeature(editor, target, 'core.move', built, 'Move');
  if (!written.ok) return { ok: false, message: written.error.message };
  const moved = Math.hypot(...delta);
  consoleLog(
    'success',
    to === 'origin'
      ? `Moved import to the origin (${moved.toFixed(1)} mm)`
      : `Dropped import onto the XY plane (${moved.toFixed(1)} mm)`,
    'move',
  );
  return { ok: true };
}
