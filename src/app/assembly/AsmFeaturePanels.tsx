/**
 * The panels of the assembly features: Component Pattern, Component Mirror
 * and Replicate. Instances are picked by clicking any face or edge of them
 * (or selected before the panel opens); clicking one again drops it. A
 * direction or axis is an axis of the assembly or a straight edge of an
 * instance; a mirror plane a default plane or a flat face; a replicate's
 * frames a flat face or a round edge, as joint ends are picked. The
 * preview shows the copies; OK writes the feature as one undo step;
 * opened on an existing feature, the panel edits its inputs.
 */
import { useState } from 'react';
import { CopyPlus } from 'lucide-react';
import { MirrorIcon, PatternIcon } from '../../icons/cadIcons.tsx';
import type { PanelProps } from '../AppShell';
import type { SelectionItem } from '../selection';
import type { AppServices } from '../services';
import { AxisRows, axisBounds } from '../modeling/BodyPanels';
import { CIRCULAR_DISTRIBUTIONS, DIRECTION_TYPES, withDistribution } from '../modeling/bodyFeatures';
import {
  Actions,
  Check,
  ErrorLine,
  ExprField,
  Note,
  PanelCard,
  PickList,
  Row,
  Select,
  ToggleRow,
  Toggles,
} from '../modeling/panelKit';
import { useClicks, usePicking, useTreeClicks } from '../modeling/usePanel';
import type { AxisChoice } from '../modeling/revolve';
import { assemblyOf, instanceAt, instanceLabel } from './assembly';
import {
  assemblyFeatureOf,
  buildAsmMirror,
  buildAsmPattern,
  buildAsmReplicate,
  instanceLabels,
  newAsmDirection,
  newAsmMirrorForm,
  newAsmPatternForm,
  newAsmReplicateForm,
  readAsmMirror,
  readAsmPattern,
  readAsmReplicate,
  toggleInstance,
  type AsmFeatureType,
  type AsmMirrorForm,
  type AsmPatternDirection,
  type AsmPatternForm,
  type AsmReplicateForm,
} from './asmFeatures';
import { selectedInstances } from './commands';
import { endFrame, jointEnd } from './joints';
import { useAssemblyPanel, type AssemblyPanelSpec } from './usePanel';

/** The row of the feature a panel was opened on, when it is of `type` in `assembly`. */
function editedRow(services: AppServices, assembly: string, feature: string | undefined, type: AsmFeatureType) {
  if (!feature) return undefined;
  const found = assemblyFeatureOf(services.editor.document, feature);
  return found && found.assembly === assembly && found.row.type === type ? found.row : null;
}

/** The top-level instance a click lands on in the panel's assembly, with its label. */
function clickedInstance(
  services: AppServices,
  assembly: string,
  item: SelectionItem,
): { id: string; label: string } | null {
  if (!('key' in item) || item.instance?.assembly !== assembly) return null;
  const id = instanceAt(services.display.getState().display, assembly, item.instance.index);
  const asm = assemblyOf(services.editor.document, assembly);
  return id && asm ? { id, label: instanceLabel(services.editor.document, asm, id) } : null;
}

/** A straight edge of an instance, as a direction or axis. */
async function pickLine(services: AppServices, assembly: string, item: SelectionItem): Promise<AxisChoice | string> {
  const at = clickedInstance(services, assembly, item);
  if (!at || !('key' in item)) return 'Click a straight edge of an instance';
  const measures = (await services.client.properties(item.key))?.measures;
  if (measures?.curve !== 'line') return 'Click a straight edge of an instance';
  const picked = await services.pick(item);
  if (!picked || 'region' in picked) return 'Click it again';
  return { picked: { reference: picked.reference, names: picked.names, label: `Edge of ${at.label}` } };
}

// ---- Component Pattern ----

const PATTERN: AssemblyPanelSpec<AsmPatternForm> = {
  title: 'Component Pattern',
  refusal: 'This pattern is not an assembly feature of the assembly shown',
  create(services, assembly, request) {
    const row = editedRow(services, assembly, request.feature, 'core.asm.pattern');
    if (row === null) return null;
    return row
      ? readAsmPattern(services.editor, row)
      : newAsmPatternForm(services.editor, assembly, selectedInstances(services, assembly));
  },
  build: buildAsmPattern,
};

type PatternSlot = 'items' | 'dir0' | 'dir1' | 'axis';

export function AsmPatternPanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const panel = useAssemblyPanel(props, PATTERN);
  const [armed, setArmed] = useState<PatternSlot>('items');
  const [hint, setHint] = useState<string | null>(null);
  usePicking(services, { kinds: armed === 'items' ? ['face', 'edge'] : ['edge'], standardPlanes: false });

  useClicks(services, viewport, (item) => {
    if (!panel || !item) return;
    if (armed === 'items') {
      const at = clickedInstance(services, panel.assembly, item);
      if (!at) {
        setHint('Click an instance of this assembly');
        return;
      }
      setHint(null);
      panel.update((f) => ({ instances: toggleInstance(f.instances, at.id) }));
      return;
    }
    const slot = armed;
    void pickLine(services, panel.assembly, item).then((axis) => {
      if (typeof axis === 'string') {
        setHint(axis);
        return;
      }
      setHint(null);
      if (slot === 'axis') panel.update((f) => ({ circular: { ...f.circular, axis } }));
      else
        panel.update((f) => ({
          directions: f.directions.map((d, i) => (i === (slot === 'dir0' ? 0 : 1) ? { ...d, axis } : d)),
        }));
      setArmed('items');
    });
  });

  if (!panel) return null;
  const { form } = panel;
  const setDirection = (i: number, patch: Partial<AsmPatternDirection>) =>
    panel.update((f) => ({ directions: f.directions.map((d, j) => (j === i ? { ...d, ...patch } : d)) }));
  return (
    <PanelCard title="Component Pattern" icon={<PatternIcon size={14} color="#6366f1" />} onClose={close}>
      <PickList
        label="Instances"
        items={instanceLabels(services.editor.document, panel.assembly, form.instances)}
        armed={armed === 'items'}
        onArm={() => setArmed('items')}
        onRemove={(i) => panel.update((f) => ({ instances: f.instances.filter((_, j) => j !== i) }))}
        empty="Click the instances to copy"
      />
      <Note message={hint} />
      {form.layout !== 'kept' && (
        <ToggleRow
          label="Type"
          value={form.layout}
          options={[
            { id: 'linear', label: 'Linear' },
            { id: 'circular', label: 'Circular' },
          ]}
          onChange={(layout) => panel.update({ layout })}
        />
      )}
      {form.layout === 'linear' &&
        form.directions.map((d, i) => (
          <div key={i}>
            <AxisRows
              label={`Direction ${i + 1}`}
              axis={d.axis}
              reversed={d.reversed}
              armed={armed === (i === 0 ? 'dir0' : 'dir1')}
              onArm={() => setArmed(i === 0 ? 'dir0' : 'dir1')}
              onAxis={(axis) => setDirection(i, { axis })}
              onReversed={(reversed) => setDirection(i, { reversed })}
              {...axisBounds(form.values, ['layout', 'linear', 'directions', i, 'direction'], d.axis, d.reversed)}
            />
            <Select
              label="Direction Type"
              value={d.symmetric ? 'symmetric' : 'one'}
              options={DIRECTION_TYPES}
              bound={form.values.boundText(['layout', 'linear', 'directions', i, 'symmetric'], d.symmetric)}
              onChange={(type) => setDirection(i, { symmetric: type === 'symmetric' })}
            />
            <ExprField
              label="Count"
              value={d.count}
              onChange={(count) => setDirection(i, { count })}
              onEnter={panel.confirm}
            />
            <ExprField
              label="Spacing"
              value={d.spacing}
              unit="mm"
              onChange={(spacing) => setDirection(i, { spacing })}
              onEnter={panel.confirm}
            />
          </div>
        ))}
      {form.layout === 'linear' && (
        <Check
          label="Second direction"
          checked={form.directions.length > 1}
          onChange={(on) =>
            panel.update((f) => ({
              directions: on ? [...f.directions.slice(0, 1), newAsmDirection('y')] : f.directions.slice(0, 1),
            }))
          }
        />
      )}
      {form.layout === 'circular' && (
        <>
          <AxisRows
            label="Axis"
            axis={form.circular.axis}
            reversed={form.circular.reversed}
            armed={armed === 'axis'}
            onArm={() => setArmed('axis')}
            onAxis={(axis) => panel.update((f) => ({ circular: { ...f.circular, axis } }))}
            onReversed={(reversed) => panel.update((f) => ({ circular: { ...f.circular, reversed } }))}
            {...axisBounds(
              form.values,
              ['layout', 'circular', 'axis'],
              form.circular.axis,
              form.circular.reversed,
              true,
            )}
          />
          <Select
            label="Distribution"
            value={form.circular.distribution}
            options={CIRCULAR_DISTRIBUTIONS}
            bound={form.values.boundText(
              ['layout', 'circular', 'symmetric'],
              form.circular.distribution === 'symmetric',
            )}
            onChange={(distribution) => panel.update((f) => ({ circular: withDistribution(f.circular, distribution) }))}
          />
          <ExprField
            label="Count"
            value={form.circular.count}
            onChange={(count) => panel.update((f) => ({ circular: { ...f.circular, count } }))}
            onEnter={panel.confirm}
          />
          {form.circular.distribution !== 'full' && (
            <ExprField
              label="Angle"
              value={form.circular.angle}
              unit="°"
              onChange={(angle) => panel.update((f) => ({ circular: { ...f.circular, angle } }))}
              onEnter={panel.confirm}
            />
          )}
        </>
      )}
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} />
    </PanelCard>
  );
}

// ---- Component Mirror ----

const MIRROR: AssemblyPanelSpec<AsmMirrorForm> = {
  title: 'Component Mirror',
  refusal: 'This mirror is not an assembly feature of the assembly shown',
  create(services, assembly, request) {
    const row = editedRow(services, assembly, request.feature, 'core.asm.mirror');
    if (row === null) return null;
    return row
      ? readAsmMirror(services.editor, row)
      : newAsmMirrorForm(services.editor, assembly, selectedInstances(services, assembly));
  },
  build: buildAsmMirror,
};

const PLANES = [
  { id: 'xy', label: 'XY' },
  { id: 'xz', label: 'XZ' },
  { id: 'yz', label: 'YZ' },
] as const;

export function AsmMirrorPanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const panel = useAssemblyPanel(props, MIRROR);
  const [armed, setArmed] = useState<'items' | 'plane'>('items');
  const [hint, setHint] = useState<string | null>(null);
  usePicking(
    services,
    armed === 'items'
      ? { kinds: ['face', 'edge'], standardPlanes: false }
      : { kinds: ['standard', 'face'], standardPlanes: true },
  );

  const onClick = (item: SelectionItem | null) => {
    if (!panel || !item) return;
    if ('standard' in item) {
      panel.update({ plane: { standard: item.standard } });
      setArmed('items');
      return;
    }
    if (armed === 'items') {
      const at = clickedInstance(services, panel.assembly, item);
      if (!at) {
        setHint('Click an instance of this assembly');
        return;
      }
      setHint(null);
      panel.update((f) => ({ instances: toggleInstance(f.instances, at.id) }));
      return;
    }
    const at = clickedInstance(services, panel.assembly, item);
    if (!at || !('key' in item)) {
      setHint('Click a plane or a flat face of an instance');
      return;
    }
    void (async () => {
      if ((await services.client.properties(item.key))?.measures.surface !== 'plane') {
        setHint('This face is not flat');
        return;
      }
      const picked = await services.pick(item);
      if (!picked || 'region' in picked) return;
      setHint(null);
      panel.update({
        plane: { picked: { reference: picked.reference, names: picked.names, label: `Face of ${at.label}` } },
      });
      setArmed('items');
    })();
  };
  useClicks(services, viewport, onClick);
  useTreeClicks(services, onClick);

  if (!panel) return null;
  const { form } = panel;
  const plane = form.plane;
  return (
    <PanelCard title="Component Mirror" icon={<MirrorIcon size={14} color="#6366f1" />} onClose={close}>
      <PickList
        label="Instances"
        items={instanceLabels(services.editor.document, panel.assembly, form.instances)}
        armed={armed === 'items'}
        onArm={() => setArmed('items')}
        onRemove={(i) => panel.update((f) => ({ instances: f.instances.filter((_, j) => j !== i) }))}
        empty="Click the instances to mirror"
      />
      <Row label="Plane">
        <Toggles
          value={plane && 'standard' in plane ? plane.standard : ('' as 'xy')}
          options={PLANES}
          onChange={(standard) => panel.update({ plane: { standard } })}
        />
      </Row>
      <PickList
        label="Mirror face"
        single
        items={plane && 'picked' in plane ? [plane.picked] : []}
        armed={armed === 'plane'}
        onArm={() => setArmed('plane')}
        onRemove={() => panel.update({ plane: null })}
        empty={armed === 'plane' ? 'Click a flat face' : 'Click here, then a flat face'}
      />
      <Note message={hint} />
      <ToggleRow
        label="Hand"
        value={form.hand}
        options={[
          { id: 'same', label: 'Same' },
          { id: 'opposite', label: 'Opposite' },
        ]}
        onChange={(hand) => panel.update({ hand })}
      />
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} />
    </PanelCard>
  );
}

// ---- Replicate ----

const REPLICATE: AssemblyPanelSpec<AsmReplicateForm> = {
  title: 'Replicate',
  refusal: 'This replicate is not an assembly feature of the assembly shown',
  create(services, assembly, request) {
    const row = editedRow(services, assembly, request.feature, 'core.asm.replicate');
    if (row === null) return null;
    return row
      ? readAsmReplicate(services.editor, row)
      : newAsmReplicateForm(services.editor, assembly, selectedInstances(services, assembly));
  },
  build: buildAsmReplicate,
};

export function AsmReplicatePanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const panel = useAssemblyPanel(props, REPLICATE);
  const [armed, setArmed] = useState<'items' | 'seed' | 'targets'>('items');
  const [hint, setHint] = useState<string | null>(null);
  usePicking(services, { kinds: ['face', 'edge'], standardPlanes: false });

  useClicks(services, viewport, (item) => {
    if (!panel || !item) return;
    const at = clickedInstance(services, panel.assembly, item);
    if (armed === 'items') {
      if (!at) {
        setHint('Click an instance of this assembly');
        return;
      }
      setHint(null);
      panel.update((f) => ({ instances: toggleInstance(f.instances, at.id) }));
      return;
    }
    const slot = armed;
    void jointEnd(services, item, at?.label ?? 'instance').then((end) => {
      if ('problem' in end) {
        setHint(end.problem);
        return;
      }
      setHint(null);
      const choice = { frame: endFrame(services.editor, end), names: end.names, label: end.label };
      if (slot === 'seed') {
        panel.update({ seed: choice });
        setArmed('targets');
      } else panel.update((f) => ({ targets: [...f.targets, choice] }));
    });
  });

  if (!panel) return null;
  const { form } = panel;
  return (
    <PanelCard title="Replicate" icon={<CopyPlus size={14} color="#6366f1" />} onClose={close}>
      <PickList
        label="Instances"
        items={instanceLabels(services.editor.document, panel.assembly, form.instances)}
        armed={armed === 'items'}
        onArm={() => setArmed('items')}
        onRemove={(i) => panel.update((f) => ({ instances: f.instances.filter((_, j) => j !== i) }))}
        empty="Click the instances to replicate"
      />
      <PickList
        label="Where they sit"
        single
        items={form.seed ? [form.seed] : []}
        armed={armed === 'seed'}
        onArm={() => setArmed('seed')}
        onRemove={() => panel.update({ seed: null })}
        empty="Click the face or round edge they sit on"
      />
      <PickList
        label="Where copies go"
        items={form.targets}
        armed={armed === 'targets'}
        onArm={() => setArmed('targets')}
        onRemove={(i) => panel.update((f) => ({ targets: f.targets.filter((_, j) => j !== i) }))}
        empty="Click faces or round edges like it"
      />
      <Note message={hint} />
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} />
    </PanelCard>
  );
}
