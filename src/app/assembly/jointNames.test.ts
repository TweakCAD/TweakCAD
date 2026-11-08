import { describe, expect, it } from 'vitest';
import { Editor, seededIds, type EditorCommand, type Json } from '@tweakcad/editor';
import { standardDocument } from '../../../lib/editor/src/testDocs';
import { literal } from '../modeling/common';
import {
  assemblyOf,
  assemblyView,
  jointLabel,
  jointLockCommands,
  jointLocked,
  jointOriginRow,
  jointRow,
  newAssemblyCommands,
  removeJointsCommands,
  renameJointCommand,
} from './assembly';
import { isJointAction, jointMenu } from './jointActions';

/** An assembly of the standard part with two revolute joints between fixed frames. */
function hinged() {
  const { doc, ids } = standardDocument();
  const editor = new Editor(doc, { ids: seededIds(7) });
  const run = (commands: EditorCommand[]) => {
    for (const c of commands) {
      const r = editor.dispatch(c);
      if (!r.ok) throw new Error(r.error.message);
    }
  };
  const made = newAssemblyCommands(editor, 'Assembly', [ids.part, ids.part]);
  run(made.commands);
  const frame = (): Json => ({
    fixed: { placement: literal(editor, 'placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))') },
  });
  const joints = [0, 1].map(() => {
    const [a, b] = [jointOriginRow(editor, frame()), jointOriginRow(editor, frame())];
    const joint = jointRow(editor, 'revolute', a.id as string, b.id as string);
    run([
      { type: 'addAssemblyRow', assembly: made.assembly, table: 'jointOrigins', row: a },
      { type: 'addAssemblyRow', assembly: made.assembly, table: 'jointOrigins', row: b },
      { type: 'addAssemblyRow', assembly: made.assembly, table: 'joints', row: joint },
    ]);
    return joint.id as string;
  });
  const asm = () => assemblyOf(editor.document, made.assembly) as Json;
  return { editor, run, asm, joints: joints as [string, string] };
}

describe('joint names', () => {
  it('shows a joint by its name, and by its kind and number without one', () => {
    const h = hinged();
    const [first, second] = h.joints;
    expect(jointLabel(h.asm(), second)).toBe('Revolute 2');
    h.run([renameJointCommand(second, '  Lid hinge ')]);
    expect(jointLabel(h.asm(), second)).toBe('Lid hinge');
    expect(jointLabel(h.asm(), first)).toBe('Revolute 1');
    h.run([renameJointCommand(second, '')]);
    expect(jointLabel(h.asm(), second)).toBe('Revolute 2');
    expect(h.editor.undo()).toBe(true);
    expect(jointLabel(h.asm(), second)).toBe('Lid hinge');
  });
});

describe('joint locks', () => {
  it('locks a joint with an attribute of its assembly, and unlocking removes it', () => {
    const h = hinged();
    const [first, second] = h.joints;
    h.run(jointLockCommands(h.editor, h.asm(), first, true));
    expect(jointLocked(h.editor.document, h.asm(), first)).toBe(true);
    expect(jointLocked(h.editor.document, h.asm(), second)).toBe(false);
    expect(h.asm().attributes).toEqual([expect.objectContaining({ target: { object: { joint: { id: first } } } })]);
    expect(assemblyView(h.editor.document, h.asm().id as string, null)?.joints.map((j) => j.locked)).toEqual([
      true,
      false,
    ]);
    // Locking again changes nothing; unlocking clears the attribute.
    expect(jointLockCommands(h.editor, h.asm(), first, true)).toHaveLength(1);
    expect(jointLockCommands(h.editor, h.asm(), second, false)).toEqual([]);
    h.run(jointLockCommands(h.editor, h.asm(), first, false));
    expect(h.asm().attributes).toEqual([]);
    expect(h.editor.undo()).toBe(true);
    expect(jointLocked(h.editor.document, h.asm(), first)).toBe(true);
  });

  it('removes the lock with the joint', () => {
    const h = hinged();
    const [first] = h.joints;
    h.run(jointLockCommands(h.editor, h.asm(), first, true));
    h.run(removeJointsCommands(h.asm(), [first]));
    expect(h.asm().attributes).toEqual([]);
    expect((h.asm().joints as Json[]).map((j) => j.id)).toEqual([h.joints[1]]);
  });
});

describe('a joint chip menu', () => {
  it('offers Edit, Rename, Drive, Animate, Lock Motion, Suppress and Delete', () => {
    expect(jointMenu({ suppressed: false }).map((e) => e.label)).toEqual([
      'Edit Joint',
      'Rename',
      'Drive Joint',
      'Animate Joint',
      'Lock Motion',
      'Suppress',
      'Delete',
    ]);
    expect(jointMenu({ suppressed: true }).map((e) => e.label)).toContain('Unsuppress');
    expect(jointMenu({ suppressed: false }).every((e) => e.action === 'rename' || isJointAction(e.action))).toBe(true);
    expect(isJointAction('suppress')).toBe(false);
  });

  it('offers no Drive or Animate on a locked joint, and Unlock Motion', () => {
    expect(jointMenu({ suppressed: false }, true).map((e) => e.label)).toEqual([
      'Edit Joint',
      'Rename',
      'Unlock Motion',
      'Suppress',
      'Delete',
    ]);
  });
});
