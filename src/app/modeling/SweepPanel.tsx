/**
 * The Sweep panel: profiles clicked in the viewport, a path of sketch curves,
 * edges or a region, how the profile turns along it, the operation and its
 * target bodies, with a live preview. A click on a sketch curve takes the
 * curves joined to it end to end, so a drawn path is one click. A profile
 * whose region is gone is listed in red, and a region clicked takes its place.
 */
import { useEffect, useState } from 'react';
import { SweepIcon } from '../../icons/cadIcons.tsx';
import type { PanelProps } from '../AppShell';
import { bodiesOf, findFeature } from '../features';
import type { SelectionItem } from '../selection';
import type { AppServices } from '../services';
import { sameReference, type FeatureTarget } from './feature';
import { Actions, ErrorLine, Note, PanelCard, PickList, Row, ToggleRow } from './panelKit';
import { kindOf, pickFor } from './picks';
import { profileOf, profileReferences, profilesSketch, regionAt, startingProfiles, toggleProfile } from './profiles';
import { useProfileSketches } from './profileSketches';
import { ProfileRow } from './ProfileRow';
import { OPERATION_OPTIONS } from './RevolvePanel';
import { connectedCurves } from './sweepChains';
import {
  buildSweep,
  chainReferences,
  newSweepForm,
  readSweep,
  sweepSketches,
  type ChainPick,
  type SweepForm,
  type SweepOrientation,
} from './sweep';
import { TARGET_PICKING, TargetBodies, toggleTarget } from './TargetBodies';
import { useClicks, useFeaturePanel, usePicking, useShownPicks, type PanelSpec } from './usePanel';

const SPEC: PanelSpec<SweepForm> = {
  type: 'core.sweep',
  baseName: 'Sweep',
  create: (services, part) =>
    newSweepForm(services.editor.newId('sec'), bodiesOf(services.display.getState().display, part).length > 0),
  read: readSweep,
  build: buildSweep,
};

const ORIENTATIONS: { id: SweepOrientation; label: string; title: string }[] = [
  { id: 'followPath', label: 'Follow', title: 'The profile turns with the path' },
  { id: 'fixed', label: 'Fixed', title: 'The profile keeps one orientation' },
  { id: 'guide', label: 'Guide', title: 'A second curve turns the profile' },
];

/** What viewport clicks may land on while a chain is armed. */
const CHAIN_PICKING = { kinds: ['sketchCurve', 'edge', 'region'], standardPlanes: false } as const;

/** The links a click on `item` adds to a chain: the curves joined to a sketch curve, an edge, or a region. */
async function linksAt(
  services: AppServices,
  target: FeatureTarget,
  part: string,
  item: SelectionItem,
): Promise<ChainPick[]> {
  if (!('key' in item) || item.instance) return [];
  const display = services.display.getState().display;
  if (kindOf(display, item) === 'region' || regionAt(display, part, item.key)) {
    const region = await profileOf(services, part, item.key);
    if (!region) return [];
    const sketch =
      'kept' in region ? 'Region' : String(findFeature(services.editor.document, region.sketch)?.name ?? 'Sketch');
    return [{ region, label: `Loop of ${sketch}` }];
  }
  const keys = connectedCurves(display, part, item.key);
  const picks = await Promise.all(keys.map((key) => pickFor(services, target, { key })));
  return picks.filter((p) => p !== null);
}

/** `chain` with `links` added, or taken off again when the click lands on what it holds. */
function toggled(chain: readonly ChainPick[], links: readonly ChainPick[]): ChainPick[] {
  const same = (a: ChainPick, b: ChainPick) => {
    if ('reference' in a && 'reference' in b) return sameReference(a.reference, b.reference);
    return JSON.stringify(chainReferences([a]).refs) === JSON.stringify(chainReferences([b]).refs);
  };
  const held = links.some((l) => chain.some((c) => same(c, l)));
  return held ? chain.filter((c) => !links.some((l) => same(c, l))) : [...chain, ...links];
}

export function SweepPanel(props: PanelProps) {
  const { services, request, viewport, close } = props;
  const panel = useFeaturePanel(props, SPEC);
  const [armed, setArmed] = useState<'profiles' | 'path' | 'guide' | 'targets'>('profiles');
  const [hint, setHint] = useState<string | null>(null);
  const part = panel?.target.part ?? null;
  const form = panel?.form;

  // A new sweep starts with the selected regions, or the only region of its sketch.
  useEffect(() => {
    if (!panel || request.feature || !part) return;
    let cancelled = false;
    void startingProfiles(services, part, request.from).then((found) => {
      if (cancelled) return;
      if (found.length > 0) {
        panel.update((f) => (f.profiles.length === 0 ? { profiles: found } : {}));
        setArmed('path');
      }
    });
    return () => {
      cancelled = true;
    };
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useProfileSketches(services, part, form ? sweepSketches(form, request.from) : { profiles: [] });

  usePicking(
    services,
    armed === 'targets'
      ? TARGET_PICKING
      : armed === 'profiles'
        ? { kinds: ['region'], standardPlanes: false }
        : CHAIN_PICKING,
  );
  const targetRefs = form && form.operation !== 'new' ? form.targets.map((t) => t.reference) : [];
  useShownPicks(services, part, [
    ...profileReferences(form?.profiles ?? []).refs,
    ...chainReferences(form?.path ?? []).refs,
    ...chainReferences(form?.guide ?? []).refs,
    ...targetRefs,
  ]);

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
          panel.update((f) => ({ profiles: r.toggle(f.profiles), keptSection: null }));
          if (panel.latest.current.path.length === 0) setArmed('path');
        }
      });
      return;
    }
    const field = armed;
    void linksAt(services, panel.target, part, item).then((links) => {
      if (links.length === 0) {
        setHint('That is not there before this sweep; pick another');
        return;
      }
      setHint(null);
      panel.update((f) => ({ [field]: toggled(f[field], links) }));
    });
  });

  if (!panel || !form) return null;
  const sketch = profilesSketch(form.profiles) ?? request.from;
  const sketchName = sketch ? String(findFeature(services.editor.document, sketch)?.name ?? 'Sketch') : 'Sketch';

  return (
    <PanelCard title="Sweep" icon={<SweepIcon size={14} color="#eab308" />} onClose={close}>
      {form.keptSection ? (
        <Row label="Profile">
          <span style={{ fontSize: 12, color: '#2196f3' }}>Circle</span>
        </Row>
      ) : (
        <ProfileRow
          profiles={form.profiles}
          sketchName={sketchName}
          onActivate={() => setArmed('profiles')}
          onRemove={(index) => panel.update((f) => ({ profiles: f.profiles.filter((_, i) => i !== index) }))}
        />
      )}
      <PickList
        label="Path"
        items={form.path}
        armed={armed === 'path'}
        onArm={() => setArmed('path')}
        onRemove={(i) => panel.update({ path: form.path.filter((_, j) => j !== i) })}
        empty={armed === 'path' ? 'Click a sketch curve, an edge or a region' : 'Click here, then the path in the view'}
      />
      <ToggleRow
        label="Follow"
        value={form.orientation}
        options={ORIENTATIONS}
        onChange={(orientation) => panel.update({ orientation })}
      />
      {form.orientation === 'guide' && (
        <PickList
          label="Guide"
          items={form.guide}
          armed={armed === 'guide'}
          onArm={() => setArmed('guide')}
          onRemove={(i) => panel.update({ guide: form.guide.filter((_, j) => j !== i) })}
          empty={armed === 'guide' ? 'Click the curve that turns the profile' : 'Click here, then a curve in the view'}
        />
      )}
      <Note message={hint} />
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
