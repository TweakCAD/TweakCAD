/**
 * Derive: another part's, an assembly's or a library component's bodies
 * brought into the active part (11.1), offset, optionally reflected in a
 * default plane for an opposite-hand part, as a new body, joined or cut.
 */
import { Copy } from 'lucide-react';
import type { PanelProps } from '../AppShell';
import { Actions, ErrorLine, ExprField, PanelCard, Select, ToggleRow } from '../modeling/panelKit';
import { useFeaturePanel, type PanelSpec } from '../modeling/usePanel';
import {
  buildDerive,
  deriveSources,
  newDeriveForm,
  readDerive,
  sourceKey,
  sourceOfKey,
  type DeriveForm,
} from './derive';

const SPEC: PanelSpec<DeriveForm> = {
  type: 'core.derive',
  baseName: 'Derive',
  create: (services, part) => newDeriveForm(services.editor.document, part, services.editor.newId('inst')),
  read: readDerive,
  build: buildDerive,
};

export function DerivePanel(props: PanelProps) {
  const { services, close } = props;
  const panel = useFeaturePanel(props, SPEC);
  if (!panel) return null;
  const { form } = panel;
  const sources = deriveSources(services.editor.document, panel.target.part).map((s) => ({
    id: s.key,
    label: s.label,
  }));
  return (
    <PanelCard title="Derive" icon={<Copy size={14} color="#6366f1" />} onClose={close}>
      {sources.length === 0 ? (
        <div style={{ fontSize: 12, color: '#666' }}>There is no other part to derive from yet.</div>
      ) : (
        <Select
          label="From"
          value={sourceKey(form.source)}
          options={sources}
          onChange={(key) => panel.update({ source: sourceOfKey(key) })}
        />
      )}
      <ExprField label="X" value={form.x} unit="mm" onChange={(x) => panel.update({ x })} onEnter={panel.confirm} />
      <ExprField label="Y" value={form.y} unit="mm" onChange={(y) => panel.update({ y })} onEnter={panel.confirm} />
      <ExprField label="Z" value={form.z} unit="mm" onChange={(z) => panel.update({ z })} onEnter={panel.confirm} />
      <ToggleRow
        label="Mirror"
        value={form.mirror}
        options={[
          { id: 'none', label: 'None' },
          { id: 'xy', label: 'XY' },
          { id: 'xz', label: 'XZ' },
          { id: 'yz', label: 'YZ' },
        ]}
        onChange={(mirror) => panel.update({ mirror })}
      />
      <ToggleRow
        label="Operation"
        value={form.operation}
        options={[
          { id: 'new', label: 'New' },
          { id: 'join', label: 'Join' },
          { id: 'cut', label: 'Cut' },
        ]}
        bound={panel.values.boundText(['operation', 'op'], form.operation)}
        onChange={(operation) => panel.update({ operation })}
      />
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} />
    </PanelCard>
  );
}
