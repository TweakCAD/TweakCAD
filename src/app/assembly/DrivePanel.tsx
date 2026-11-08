/**
 * Drive Joint: a value for each degree of freedom of one joint; the preview
 * moves the instances as the solve places them, and OK writes the joint's
 * state and the pose.
 */
import { Gauge } from 'lucide-react';
import type { PanelProps } from '../AppShell';
import { Actions, ErrorLine, ExprField, PanelCard } from '../modeling/panelKit';
import {
  DOF_LABELS,
  JOINT_KINDS,
  assemblyOf,
  isTranslation,
  jointLabel,
  jointLocked,
  rowsOf,
  type JointKind,
} from './assembly';
import { assemblyDisplay } from './focus';
import { numberOf } from './joints';
import { useAssemblyPanel, type AssemblyPanelSpec } from './usePanel';

interface DriveForm {
  joint: string;
  values: Record<string, string>;
}

const SPEC: AssemblyPanelSpec<DriveForm> = {
  title: 'Drive Joint',
  refusal: 'Unlock the joint to drive it',
  create(services, assembly, request) {
    const asm = assemblyOf(services.editor.document, assembly);
    const joint = rowsOf(asm, 'joints').find((j) => j.id === request.from);
    // A locked joint holds where it stands; it is unlocked first.
    if (!joint || jointLocked(services.editor.document, asm, joint.id as string)) return null;
    const solved = assemblyDisplay(services.display.getState().display, assembly)?.joints[joint.id as string] ?? {};
    const dofs = JOINT_KINDS[joint.kind as JointKind]?.dofs ?? [];
    return {
      joint: joint.id as string,
      values: Object.fromEntries(dofs.map((d) => [d, String(Math.round((solved[d] ?? 0) * 1e6) / 1e6)])),
    };
  },
  build(editor, assembly, form) {
    const state: Record<string, number> = {};
    for (const [dof, text] of Object.entries(form.values)) {
      const n = numberOf(text);
      if (n === null)
        return {
          ok: false,
          message: `${DOF_LABELS[dof] ?? dof} is a number of ${isTranslation(dof) ? 'mm' : 'degrees'}`,
        };
      state[dof] = n;
    }
    const asm = assemblyOf(editor.document, assembly);
    return {
      ok: true,
      commands: [{ type: 'editAssemblyRow', row: form.joint, set: { state } }],
      label: `Drive ${asm ? jointLabel(asm, form.joint) : 'joint'}`,
    };
  },
};

export function DrivePanel(props: PanelProps) {
  const { services, close } = props;
  const panel = useAssemblyPanel(props, SPEC);
  if (!panel) return null;
  const asm = assemblyOf(services.editor.document, panel.assembly);
  return (
    <PanelCard
      title={`Drive ${asm ? jointLabel(asm, panel.form.joint) : 'Joint'}`}
      icon={<Gauge size={14} color="#6366f1" />}
      onClose={close}
    >
      {Object.keys(panel.form.values).length === 0 && (
        <div style={{ fontSize: 12, color: '#666', padding: '4px 0' }}>A rigid joint does not move.</div>
      )}
      {Object.entries(panel.form.values).map(([dof, text], i) => (
        <ExprField
          key={dof}
          label={DOF_LABELS[dof] ?? dof}
          value={text}
          unit={isTranslation(dof) ? 'mm' : '°'}
          autoFocus={i === 0}
          onChange={(v) => panel.update((f) => ({ values: { ...f.values, [dof]: v } }))}
          onEnter={panel.confirm}
        />
      ))}
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} />
    </PanelCard>
  );
}
