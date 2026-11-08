/**
 * The Loft panel: profiles clicked in the viewport, in order, across any
 * sketches; ruled and closed; the operation and its target bodies, with a live
 * preview. A section whose region is gone stays in its place in red, and a
 * region clicked takes it.
 */
import { useEffect, useState } from 'react';
import { LoftIcon } from '../../icons/cadIcons.tsx';
import type { PanelProps } from '../AppShell';
import { bodiesOf, featureDisplayName, findFeature } from '../features';
import type { ExtrudeProfile } from './extrude';
import {
  buildLoft,
  loftSketches,
  newLoftForm,
  readLoft,
  sectionProfiles,
  sectionsCount,
  withProfiles,
  type LoftForm,
  type LoftSection,
} from './loft';
import { Actions, Check, ErrorLine, Note, PanelCard, PickList, ToggleRow } from './panelKit';
import { isMissingProfile, profileReferences, startingProfiles, toggleProfile } from './profiles';
import { useProfileSketches } from './profileSketches';
import { OPERATION_OPTIONS } from './RevolvePanel';
import { TARGET_PICKING, TargetBodies, toggleTarget } from './TargetBodies';
import { useClicks, useFeaturePanel, usePicking, useShownPicks, type PanelSpec } from './usePanel';

const SPEC: PanelSpec<LoftForm> = {
  type: 'core.loft',
  baseName: 'Loft',
  create: (services, part) => newLoftForm(bodiesOf(services.display.getState().display, part).length > 0),
  read: readLoft,
  build: buildLoft,
};

export function LoftPanel(props: PanelProps) {
  const { services, request, viewport, close } = props;
  const panel = useFeaturePanel(props, SPEC);
  const [armed, setArmed] = useState<'sections' | 'targets'>('sections');
  const [hint, setHint] = useState<string | null>(null);
  const part = panel?.target.part ?? null;
  const form = panel?.form;

  const asSections = (profiles: readonly ExtrudeProfile[], current: readonly LoftSection[]): LoftSection[] =>
    withProfiles(current, profiles, () => services.editor.newId('sec'));

  // A new loft starts with the selected regions, in the order they were picked.
  useEffect(() => {
    if (!panel || request.feature || !part) return;
    let cancelled = false;
    void startingProfiles(services, part, undefined).then((found) => {
      if (!cancelled && found.length > 0)
        panel.update((f) => (f.sections.length === 0 ? { sections: asSections(found, []) } : {}));
    });
    return () => {
      cancelled = true;
    };
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useProfileSketches(
    services,
    part,
    form && panel ? loftSketches(form, panel.target.base, request.from) : { profiles: [] },
  );

  usePicking(services, armed === 'targets' ? TARGET_PICKING : { kinds: ['region'], standardPlanes: false });
  const shown = sectionProfiles(form?.sections ?? []).filter((p) => !isMissingProfile(p));
  const targetRefs = form && form.operation !== 'new' ? form.targets.map((t) => t.reference) : [];
  useShownPicks(services, part, [...profileReferences(shown).refs, ...targetRefs]);

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
    if (item.instance) return;
    void toggleProfile(services, part, sectionProfiles(panel.latest.current.sections), item.key, {
      anySketch: true,
    }).then((r) => {
      if (!r || 'hint' in r) return;
      setHint(null);
      panel.update((f) => ({ sections: asSections(r.toggle(sectionProfiles(f.sections)), f.sections) }));
    });
  });

  if (!panel || !form) return null;
  const row = (s: LoftSection) => {
    if ('written' in s) return { label: 'Section' };
    if ('kept' in s.profile) return { label: 'Missing profile', missing: true };
    const sketch = findFeature(services.editor.document, s.profile.sketch);
    return { label: sketch ? featureDisplayName(sketch, services.editor.document) : 'Sketch' };
  };

  return (
    <PanelCard title="Loft" icon={<LoftIcon size={14} color="#eab308" />} onClose={close}>
      <PickList
        label="Profiles"
        count={sectionsCount(form.sections)}
        items={form.sections.map(row)}
        armed={armed === 'sections'}
        onArm={() => setArmed('sections')}
        onRemove={(i) => panel.update({ sections: form.sections.filter((_, j) => j !== i) })}
        empty="Click profiles in the view, in order"
      />
      <Note message={hint} />
      <Check
        label="Ruled (straight segments)"
        checked={form.ruled}
        bound={panel.values.boundText(['ruled'], form.ruled)}
        onChange={(ruled) => panel.update({ ruled })}
      />
      <Check
        label="Closed loop"
        checked={form.closed}
        bound={panel.values.boundText(['closed'], form.closed)}
        onChange={(closed) => panel.update({ closed })}
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
