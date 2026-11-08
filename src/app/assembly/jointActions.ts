/**
 * Joints in the assembly's timeline: a chip per joint (after the assembly's
 * features, in the order the joints were made, which the document keeps),
 * opened for editing by a double-click, with Edit, Rename, Drive, Animate,
 * Lock Motion, Suppress and Delete in its menu. A locked joint holds where it
 * stands (Lock Motion), so its menu has no Drive or Animate until it is
 * unlocked.
 *
 * Animate plays the joint through its range in the view and writes
 * nothing: each turn or slide between its limits (a free turn goes round
 * once, a free slide 20 mm each way), then back to where it stood.
 */
import { ValueEvaluator, isPlainObject } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { flagReader, type FeatureRow } from '../features';
import type { AppServices } from '../services';
import { JOINT_KINDS, assemblyOf, isTranslation, jointLabel, jointLocked, rowsOf, type JointKind } from './assembly';
import { candidateOf } from './commit';
import { removeJoint, setJointLocked, setJointSuppressed, startAssemblyPanel } from './commands';
import { assemblyDisplay } from './focus';

/** The timeline chips of an assembly's joints. */
export function jointTimelineRows(doc: Doc, assembly: string, display: Display | null): FeatureRow[] {
  const asm = assemblyOf(doc, assembly);
  if (!asm) return [];
  const paused = new Map((display?.pauses ?? []).map((p) => [p.feature, p.message]));
  const flag = flagReader(doc);
  return rowsOf(asm, 'joints').map((j) => {
    const id = String(j.id);
    const suppressed = flag(j.suppressed);
    const message = paused.get(id);
    return {
      id,
      name: jointLabel(asm, id),
      type: 'joint',
      iconKey: 'joint',
      suppressed,
      frozen: false,
      status: suppressed ? 'suppressed' : message !== undefined ? 'failed' : 'success',
      ...(message !== undefined && !suppressed ? { message } : {}),
      hidden: false,
      joint: true,
      children: [],
    };
  });
}

export type JointAction = 'editJoint' | 'driveJoint' | 'animateJoint' | 'lockJoint' | 'suppressJoint' | 'deleteJoint';

const ACTIONS: ReadonlySet<string> = new Set<JointAction>([
  'editJoint',
  'driveJoint',
  'animateJoint',
  'lockJoint',
  'suppressJoint',
  'deleteJoint',
]);

export const isJointAction = (action: string): action is JointAction => ACTIONS.has(action);

/** A joint chip's menu; `rename` is the timeline's own, which names the chip in place. */
export function jointMenu(
  row: Pick<FeatureRow, 'suppressed'>,
  locked = false,
): { action: JointAction | 'rename'; label: string; danger?: boolean }[] {
  return [
    { action: 'editJoint', label: 'Edit Joint' },
    { action: 'rename', label: 'Rename' },
    ...(locked
      ? []
      : [
          { action: 'driveJoint' as const, label: 'Drive Joint' },
          { action: 'animateJoint' as const, label: 'Animate Joint' },
        ]),
    { action: 'lockJoint', label: locked ? 'Unlock Motion' : 'Lock Motion' },
    { action: 'suppressJoint', label: row.suppressed ? 'Unsuppress' : 'Suppress' },
    { action: 'deleteJoint', label: 'Delete', danger: true },
  ];
}

/** Opens a joint for editing, as a double-click on it does. */
export function editJoint(services: AppServices, joint: string): void {
  startAssemblyPanel(services, 'assembly.joint', 'Edit Joint', joint);
}

export function runJointAction(services: AppServices, assembly: string, action: JointAction, joint: string): void {
  switch (action) {
    case 'editJoint':
      editJoint(services, joint);
      return;
    case 'driveJoint':
      startAssemblyPanel(services, 'assembly.drive', 'Drive Joint', joint);
      return;
    case 'animateJoint':
      void animateJoint(services, assembly, joint);
      return;
    case 'lockJoint':
      void setJointLocked(
        services,
        assembly,
        joint,
        !jointLocked(services.editor.document, assemblyOf(services.editor.document, assembly), joint),
      );
      return;
    case 'suppressJoint': {
      const row = rowsOf(assemblyOf(services.editor.document, assembly), 'joints').find((j) => j.id === joint);
      void setJointSuppressed(services, assembly, joint, !flagReader(services.editor.document)(row?.suppressed));
      return;
    }
    case 'deleteJoint':
      void removeJoint(services, assembly, joint);
  }
}

/** How far a free slide goes each way when animated, in mm. */
const FREE_SLIDE = 20;

/**
 * The values a joint's degrees of freedom take through an animation, frame
 * by frame: from where each stands to one end of its range, across to the
 * other and back, all together; a free turn goes once round.
 */
export function animationFrames(
  dofs: readonly string[],
  at: Readonly<Record<string, number>>,
  limits: Readonly<Record<string, { min: number; max: number } | null>>,
  steps = 24,
): Record<string, number>[] {
  const frames: Record<string, number>[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const frame: Record<string, number> = {};
    for (const dof of dofs) {
      const start = at[dof] ?? 0;
      const range = limits[dof];
      if (range) {
        // start → max → min → start, along one path.
        const legs = [start, range.max, range.min, start];
        const s = t * 3;
        const leg = Math.min(2, Math.floor(s));
        const f = s - leg;
        frame[dof] = (legs[leg] as number) + ((legs[leg + 1] as number) - (legs[leg] as number)) * f;
      } else if (isTranslation(dof)) {
        frame[dof] = start + FREE_SLIDE * Math.sin(2 * Math.PI * t);
      } else {
        frame[dof] = start + 360 * t;
      }
    }
    frames.push(frame);
  }
  return frames;
}

/** A joint's limits as numbers, by degree of freedom; null for a free one or one that does not evaluate. */
function limitsOf(doc: Doc, joint: Json): Record<string, { min: number; max: number } | null> {
  const out: Record<string, { min: number; max: number } | null> = {};
  let values: ValueEvaluator | null;
  try {
    values = new ValueEvaluator(doc);
  } catch {
    values = null;
  }
  for (const [dof, limit] of Object.entries((joint.limits as Json | undefined) ?? {})) {
    const between = isPlainObject(limit) && isPlainObject(limit.between) ? limit.between : null;
    if (!between || !values) {
      out[dof] = null;
      continue;
    }
    const target = { type: 'number' as const, quantity: isTranslation(dof) ? 'length' : 'angle' };
    try {
      // Stored in mm and degrees, as the joint's state is.
      out[dof] = { min: values.number(between.min, target), max: values.number(between.max, target) };
    } catch {
      out[dof] = null;
    }
  }
  return out;
}

/** Plays a joint through its range in the view, writing nothing; a locked joint does not move. */
export async function animateJoint(services: AppServices, assembly: string, joint: string): Promise<void> {
  const { editor, scheduler, display } = services;
  const asm = assemblyOf(editor.document, assembly);
  const row = rowsOf(asm, 'joints').find((j) => j.id === joint);
  if (!row || jointLocked(editor.document, asm, joint)) return;
  const dofs = JOINT_KINDS[row.kind as JointKind]?.dofs ?? [];
  if (dofs.length === 0) return;
  const at = assemblyDisplay(display.getState().display, assembly)?.joints[joint] ?? {};
  const limits = limitsOf(editor.document, row);
  for (const frame of animationFrames(dofs, at, limits)) {
    const candidate = candidateOf(editor.document, [{ type: 'editAssemblyRow', row: joint, set: { state: frame } }]);
    if (!candidate.ok) break;
    scheduler.setPreview(candidate.doc);
    await scheduler.whenIdle();
  }
  scheduler.setPreview(null);
}
