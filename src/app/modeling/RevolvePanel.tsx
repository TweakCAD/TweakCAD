/**
 * The Revolve panel: profiles clicked in the viewport, an axis (one of the
 * part's axes, or a sketch line, straight edge or construction axis picked
 * in the viewport), the angle and the operation, with a live preview.
 */
import { useEffect, useState } from 'react';
import { RevolveIcon } from '../../icons/cadIcons.tsx';
import type { PanelProps } from '../AppShell';
import { bodiesOf, findFeature } from '../features';
import type { Operation } from './extrude';
import {
  buildRevolve,
  newRevolveForm,
  readRevolve,
  type RevolveExtent,
  type RevolveForm,
  type StandardAxis,
} from './revolve';
import { Actions, Check, ErrorLine, ExprField, Note, PanelCard, PickList, Row, ToggleRow, Toggles } from './panelKit';
import { pickFor } from './picks';
import { ProfileRow } from './ProfileRow';
import { profileReferences, profilesSketch, startingProfiles, toggleProfile } from './profiles';
import { useProfileSketches } from './profileSketches';
import { TARGET_PICKING, TargetBodies, toggleTarget } from './TargetBodies';
import { useClicks, useFeaturePanel, usePicking, useShownPicks, useTreeClicks, type PanelSpec } from './usePanel';

const SPEC: PanelSpec<RevolveForm> = {
  type: 'core.revolve',
  baseName: 'Revolve',
  create: (services, part) => newRevolveForm(bodiesOf(services.display.getState().display, part).length > 0),
  read: readRevolve,
  build: buildRevolve,
};

const EXTENTS: { id: RevolveExtent; label: string; title: string }[] = [
  { id: 'angle', label: 'Angle', title: 'One angle' },
  { id: 'symmetric', label: 'Symmetric', title: 'Symmetric about the sketch plane' },
  { id: 'twoSides', label: 'Two sides', title: 'Two angles' },
  { id: 'full', label: 'Full', title: 'A full turn' },
];

export const OPERATION_OPTIONS: { id: Operation; label: string }[] = [
  { id: 'new', label: 'New body' },
  { id: 'join', label: 'Join' },
  { id: 'cut', label: 'Cut' },
  { id: 'intersect', label: 'Intersect' },
];

const AXES: { id: StandardAxis; label: string }[] = [
  { id: 'x', label: 'X' },
  { id: 'y', label: 'Y' },
  { id: 'z', label: 'Z' },
];

export function RevolvePanel(props: PanelProps) {
  const { services, request, viewport, close } = props;
  const panel = useFeaturePanel(props, SPEC);
  const [armed, setArmed] = useState<'profiles' | 'axis' | 'targets'>('profiles');
  const [hint, setHint] = useState<string | null>(null);
  const part = panel?.target.part ?? null;
  const form = panel?.form;
  // The profiles' sketch shows while the panel is open; with every profile lost, the sketch the axis line comes from.
  const pickedAxis = form?.axis && 'picked' in form.axis ? form.axis.picked : null;
  useProfileSketches(services, part, {
    profiles: form?.profiles ?? [],
    references: [pickedAxis?.reference],
    names: pickedAxis?.names,
    from: request.from,
  });

  // A new revolve starts with the selected regions, or the only region of its sketch.
  useEffect(() => {
    if (!panel || request.feature || !part) return;
    let cancelled = false;
    void startingProfiles(services, part, request.from, request.regions).then((found) => {
      if (!cancelled && found.length > 0) panel.update((f) => (f.profiles.length === 0 ? { profiles: found } : {}));
    });
    return () => {
      cancelled = true;
    };
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePicking(
    services,
    armed === 'axis'
      ? { kinds: ['sketchCurve', 'edge', 'construction'], standardPlanes: false }
      : armed === 'targets'
        ? TARGET_PICKING
        : { kinds: ['region'], standardPlanes: false },
  );
  const axisRef = form?.axis && 'picked' in form.axis ? [form.axis.picked.reference] : [];
  const targetRefs = form && form.operation !== 'new' ? form.targets.map((t) => t.reference) : [];
  useShownPicks(services, part, [...profileReferences(form?.profiles ?? []).refs, ...axisRef, ...targetRefs]);

  useClicks(services, viewport, (item) => {
    if (!panel || !part || !item || !('key' in item)) return;
    if (armed === 'targets') {
      void toggleTarget(services, panel.target, item).then((r) => {
        if ('hint' in r) setHint(r.hint);
        else {
          setHint(null);
          panel.update((f) => ({ targets: r.toggle(f.targets) }));
        }
      });
      return;
    }
    if (armed === 'profiles') {
      if (item.instance) return;
      void toggleProfile(services, part, panel.latest.current.profiles, item.key).then((r) => {
        if (!r) return;
        if ('hint' in r) setHint(r.hint);
        else {
          setHint(null);
          panel.update((f) => ({ profiles: r.toggle(f.profiles) }));
        }
      });
      return;
    }
    void pickFor(services, panel.target, item).then((picked) => {
      if (!picked) {
        setHint('That line is not there before this revolve; pick another');
        return;
      }
      setHint(null);
      panel.update({ axis: { picked } });
      setArmed('profiles');
    });
  });

  // A standard axis clicked in the browser is the axis.
  useTreeClicks(services, (item) => {
    if (!panel || !('datum' in item) || item.datum === 'origin') return;
    setHint(null);
    panel.update({ axis: { standard: item.datum } });
    setArmed('profiles');
  });

  if (!panel || !form) return null;
  const sketch = profilesSketch(form.profiles) ?? request.from;
  const sketchName = sketch ? String(findFeature(services.editor.document, sketch)?.name ?? 'Sketch') : 'Sketch';
  const axisLabel = !form.axis
    ? null
    : 'standard' in form.axis
      ? `${form.axis.standard.toUpperCase()} axis`
      : form.axis.picked.label;
  const angleShown = form.extent !== 'full' && form.extent !== 'kept';

  return (
    <PanelCard title="Revolve" icon={<RevolveIcon size={14} color="#ec4899" />} onClose={close}>
      <ProfileRow
        profiles={form.profiles}
        sketchName={sketchName}
        onActivate={() => setArmed('profiles')}
        onRemove={(index) => panel.update((f) => ({ profiles: f.profiles.filter((_, i) => i !== index) }))}
      />
      <Row label="Part axis">
        <Toggles
          value={form.axis && 'standard' in form.axis ? form.axis.standard : ('' as StandardAxis)}
          options={AXES}
          onChange={(axis) => panel.update({ axis: { standard: axis } })}
        />
      </Row>
      <PickList
        label="Axis line"
        single
        items={axisLabel && form.axis && 'picked' in form.axis ? [{ label: axisLabel }] : []}
        armed={armed === 'axis'}
        onArm={() => setArmed('axis')}
        onRemove={() => panel.update({ axis: null })}
        empty={armed === 'axis' ? 'Click a sketch line, an edge or an axis' : 'Click here, then a line in the view'}
      />
      <Note message={hint} />
      <ToggleRow
        label="Extent"
        value={form.extent === 'kept' ? ('' as RevolveExtent) : form.extent}
        options={EXTENTS}
        onChange={(extent) => panel.update({ extent })}
      />
      {angleShown && (
        <ExprField
          label={form.extent === 'twoSides' ? 'Side 1' : 'Angle'}
          value={form.angle}
          unit="°"
          onChange={(angle) => panel.update({ angle })}
          onEnter={panel.confirm}
          invalid={panel.error !== null}
          autoFocus
        />
      )}
      {form.extent === 'twoSides' && (
        <ExprField
          label="Side 2"
          value={form.second}
          unit="°"
          onChange={(second) => panel.update({ second })}
          onEnter={panel.confirm}
        />
      )}
      <Check
        label="Flip"
        checked={form.reversed}
        bound={panel.values.boundText(['axis', 'along', 'reversed'], form.reversed)}
        onChange={(reversed) => panel.update({ reversed })}
      />
      <ToggleRow
        label="Operation"
        value={form.operation}
        options={OPERATION_OPTIONS}
        bound={panel.values.boundText(['operation', 'op'], form.operation)}
        onChange={(operation) => panel.update({ operation })}
      />
      {form.operation !== 'new' && (
        <TargetBodies
          targets={form.targets}
          armed={armed === 'targets'}
          onArm={() => setArmed('targets')}
          onChange={(targets) => panel.update({ targets })}
        />
      )}
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} blocked={panel.blocked} />
    </PanelCard>
  );
}
