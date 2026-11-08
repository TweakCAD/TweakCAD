/**
 * The Extrude panel: a floating card over the viewport that creates an
 * extrude, or edits one.
 *
 * - Profiles are sketch regions clicked in the viewport; a click toggles
 *   one. A sketch with one region starts with it picked. A stored profile
 *   that names no region is listed as missing; a region clicked takes its place.
 * - Start: the profile plane, an offset from it, or a face or plane picked
 *   in the viewport (Object), the profile projected onto it, moved by the offset.
 * - Direction: one side, two sides each with its own extent, or symmetric
 *   (the distance is the whole length or each half).
 * - Each side's extent: a distance, to an object (a face or plane picked in
 *   the viewport, or a body), to the next or last face met, or through
 *   all; each side has a taper angle. Values are expressions over the
 *   part's parameters and named values.
 * - Flip runs the extrude against the sketch normal. For a sketch on a body
 *   face, choosing Cut or Intersect flips it into the body and Join or New
 *   body back out, until Flip is set by hand.
 * - Operation: new body, join, cut or intersect; new when the part has no
 *   body yet, otherwise join. A join, cut or intersect acts on all bodies,
 *   or on the target bodies clicked once their list is armed.
 *
 * An arrow on the canvas at the end of the first side drags its distance.
 * A refusal shows under the field it is about. While the panel is open the
 * viewport shows a preview: the document with the pending extrude,
 * evaluated without being committed. OK writes it as one undo step; Cancel
 * and Escape write nothing.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { ExtrudeIcon } from '../../icons/cadIcons.tsx';
import type { PanelProps } from '../AppShell';
import { bodiesOf, findFeature, partOf, partOfFeature } from '../features';
import { useDocument, useSlice } from '../hooks';
import { standsBefore } from './BodyPanels';
import { keysOf, pausedLine, useBeforeState } from './usePanel';
import { isPickedRegion } from '../picking';
import type { SelectionItem } from '../selection';
import type { Viewport } from '../viewport/Viewport';
import { activePart } from './commands';
import { insertionPoint, nextFeatureName } from './common';
import {
  buildExtrude,
  candidateDocument,
  faceSketchFlip,
  newSide,
  readExtrude,
  ValueSlots,
  writeExtrude,
  type ExtentKind,
  type ExtrudeField,
  type ExtrudeForm,
  type ExtrudeProfile,
  type ExtrudeTarget,
  type Operation,
  type SideForm,
  type SideMode,
  type StartType,
} from './extrude';
import { fieldText } from './feature';
import {
  Actions,
  Check,
  ErrorLine,
  ExprField,
  MISSING_COLOR,
  PanelCard,
  Row,
  Select,
  styles,
  ToggleRow,
  type ToggleOption,
} from './panelKit';
import { ProfileRow } from './ProfileRow';
import { distanceArrow } from './extrudeArrow';
import { useArrowHandle } from './arrowHandle';
import { profileKey, profilesSketch, startingProfiles, toggleProfile } from './profiles';
import { useProfileSketches } from './profileSketches';
import { takeClicks } from './viewportClicks';
import { TARGET_PICKING, TargetBodies, toggleTarget } from './TargetBodies';

/** Milliseconds a form change waits before the preview follows it. */
const PREVIEW_DELAY = 150;

const SIDE_OPTIONS: ToggleOption<SideMode>[] = [
  { id: 'one', label: 'One side' },
  { id: 'two', label: 'Two sides' },
  { id: 'symmetric', label: 'Symmetric' },
];

/** The extents a side offers; a body stop reads as To object. */
const EXTENT_OPTIONS: { id: ExtentKind; label: string }[] = [
  { id: 'distance', label: 'Distance' },
  { id: 'toFace', label: 'To object' },
  { id: 'upToNext', label: 'To next' },
  { id: 'upToLast', label: 'To last' },
  { id: 'throughAll', label: 'All' },
];

const START_OPTIONS: { id: StartType; label: string }[] = [
  { id: 'profile', label: 'Profile plane' },
  { id: 'offset', label: 'Offset' },
  { id: 'face', label: 'Object' },
];

const MEASURE_OPTIONS: ToggleOption<'total' | 'half'>[] = [
  { id: 'total', label: 'Whole length' },
  { id: 'half', label: 'Half length' },
];

const OPERATION_OPTIONS: ToggleOption<Operation>[] = [
  { id: 'new', label: 'New body' },
  { id: 'join', label: 'Join' },
  { id: 'cut', label: 'Cut' },
  { id: 'intersect', label: 'Intersect' },
];

/** What viewport clicks pick for: profiles, a side's stop, the start, or target bodies. */
type Slot = 'profiles' | 'face' | 'face2' | 'startFace' | 'targets';

const PLANE_PICKING = { kinds: ['face', 'standard', 'construction'], standardPlanes: true } as const;

/** Expression text in degrees as a field shows it, without its unit. */
const angleText = (text: string | undefined): string => fieldText(text ?? '0', 'deg');

interface Setup {
  target: ExtrudeTarget;
  form: ExtrudeForm;
  profiles: ExtrudeProfile[];
}

/** The form as the panel shows it: lengths and angles without the unit the field shows beside them. */
function shownForm(form: ExtrudeForm): ExtrudeForm {
  const side = (s: SideForm): SideForm => ({
    ...s,
    distance: fieldText(s.distance),
    offset: fieldText(s.offset ?? '0'),
    taper: angleText(s.taper),
  });
  return {
    ...form,
    distance: fieldText(form.distance),
    offset: fieldText(form.offset ?? '0'),
    taper: angleText(form.taper),
    ...(form.side2 ? { side2: side(form.side2) } : {}),
    ...(form.startOffset !== undefined ? { startOffset: fieldText(form.startOffset) } : {}),
  };
}

/** The form fields of one side, so one block of the panel can show either. */
interface SideView {
  side: SideForm;
  slot: 'face' | 'face2';
  fields: { distance: ExtrudeField; face: ExtrudeField; offset: ExtrudeField; taper: ExtrudeField };
  set: (patch: Partial<SideForm>) => void;
}

export function ExtrudePanel({ services, request, viewport, close }: PanelProps) {
  const { editor, display: displayStore, scheduler, selection, app } = services;

  // What the panel writes: a new feature, or the one it edits.
  const setup = useMemo<Setup | null>(() => {
    const doc = editor.document;
    if (request.feature) {
      const part = partOfFeature(doc, request.feature);
      const read = part ? readExtrude(doc, part, request.feature) : null;
      if (!part || !read) return null;
      return {
        target: { part, feature: request.feature, base: read.inputs },
        form: shownForm(read.form),
        profiles: read.profiles,
      };
    }
    const part = activePart(services);
    if (!part) return null;
    const before = insertionPoint(doc, part);
    const hasBody = bodiesOf(displayStore.getState().display, part).length > 0;
    return {
      target: {
        part,
        feature: editor.newId('feat'),
        name: nextFeatureName(doc, part, 'Extrude'),
        ...(before ? { before } : {}),
      },
      form: {
        sides: 'one',
        extent: 'distance',
        distance: '10',
        face: null,
        offset: '0',
        taper: '0',
        reversed: false,
        operation: hasBody ? 'join' : 'new',
        targets: [],
        startType: 'profile',
        startOffset: '0',
      },
      profiles: [],
    };
    // The panel is keyed by its request; what it writes is settled when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [form, setForm] = useState<ExtrudeForm>(
    () => setup?.form ?? { extent: 'distance', distance: '10', reversed: false, operation: 'new', face: null },
  );
  const [profiles, setProfiles] = useState<ExtrudeProfile[]>(() => setup?.profiles ?? []);
  // A refusal, and the field it is about (null: the feature as a whole).
  const [error, setError] = useState<{ message: string; field: ExtrudeField | null } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [armed, setArmed] = useState<Slot>('profiles');
  // What each side's To list shows for its stop: a face, a standard plane, or `cp:<feature>` for a construction plane.
  const [toChoice, setToChoice] = useState<Record<'face' | 'face2', string>>(() => ({
    face: (setup?.form.face?.reference as { standard?: { name?: string } } | undefined)?.standard?.name ?? 'face',
    face2:
      (setup?.form.side2?.face?.reference as { standard?: { name?: string } } | undefined)?.standard?.name ?? 'face',
  }));
  // Read against the document the panel opened on, as the form was.
  const values = useMemo(
    () => new ValueSlots(() => editor.newId('val'), setup?.target.base, editor.document),
    [editor, setup],
  );
  // A change to the document (a parameter, a configuration) rebuilds the preview.
  const doc = useDocument(editor);
  const display = useSlice(displayStore, (s) => s.display);
  // Why the extrude does not build as the view shows it; OK still writes it.
  const editing = setup?.target.feature;
  const paused = useSlice(displayStore, (s) =>
    editing === undefined || !s.preview
      ? null
      : (s.display?.pauses.find((p) => p.feature === editing)?.message ?? null),
  );
  // Choosing Cut or Intersect for a profile of a sketch on a body face flips the extrude into the body, and
  // Join or New body flips it back out, until Flip is set by hand in this panel.
  const [flippedByHand, setFlippedByHand] = useState(false);
  const operationFlip = faceSketchFlip(doc, profilesSketch(profiles), form.operation);
  const [lastOperationFlip, setLastOperationFlip] = useState(operationFlip);
  if (operationFlip !== lastOperationFlip) {
    setLastOperationFlip(operationFlip);
    if (operationFlip !== null && !flippedByHand) setForm((f) => ({ ...f, reversed: operationFlip }));
  }
  const latest = useRef({ form, profiles, armed });
  useLayoutEffect(() => {
    latest.current = { form, profiles, armed };
  });
  useBeforeState(services, setup?.target ?? null, setup?.form ?? null, setForm);
  const part = setup?.target.part ?? null;
  // The profiles' sketch shows while the panel is open; with every profile lost, the sketch the direction names.
  useProfileSketches(services, part, { profiles, references: [setup?.target.base?.direction], from: request.from });

  // A new extrude starts with the selected regions of its sketch, or the sketch's only region.
  useEffect(() => {
    if (!setup || request.feature || !part) return;
    let cancelled = false;
    void startingProfiles(services, part, request.from, request.regions).then((found) => {
      if (!cancelled && found.length > 0) setProfiles((now) => (now.length === 0 ? found : now));
    });
    return () => {
      cancelled = true;
    };
  }, [setup, request.feature, request.from, request.regions, part, services]);

  // An edited extrude up to a construction plane shows the plane in the To list.
  useEffect(() => {
    if (!part) return;
    for (const slot of ['face', 'face2'] as const) {
      const face = slot === 'face' ? setup?.form.face : setup?.form.side2?.face;
      if (!face || 'standard' in face.reference) continue;
      void keysOf(services, part, [face.reference]).then((items) => {
        const item = items[0];
        const entity = item && 'key' in item ? displayStore.getState().display?.entities[item.key] : undefined;
        if (entity?.kind === 'plane') setToChoice((c) => ({ ...c, [slot]: `cp:${entity.feature}` }));
      });
    }
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the viewport picks: regions for profiles, a face or plane for a stop or the start, or bodies.
  useEffect(() => {
    app.setState({
      picking:
        armed === 'targets'
          ? { ...TARGET_PICKING, kinds: [...TARGET_PICKING.kinds] }
          : armed === 'profiles'
            ? { kinds: ['region'], standardPlanes: false }
            : { ...PLANE_PICKING, kinds: [...PLANE_PICKING.kinds] },
    });
  }, [app, armed]);
  useEffect(() => () => app.setState({ picking: null }), [app]);

  // The picked profiles show selected in whatever the viewport shows.
  useEffect(() => {
    if (!part) return;
    const show = () => {
      const shown = displayStore.getState().display;
      const items: SelectionItem[] = latest.current.profiles.flatMap((p) => {
        const key = profileKey(shown, part, p);
        return key === null ? [] : [{ key }];
      });
      selection.setState({ items, generation: shown?.generation ?? null });
    };
    show();
    return displayStore.subscribe((s, prev) => {
      if (s.display !== prev.display) show();
    });
  }, [part, profiles, displayStore, selection]);
  useEffect(() => () => selection.setState({ items: [], hover: null }), [selection]);

  const pickProfile = useCallback(
    async (item: SelectionItem | null) => {
      if (!part || !item || !('key' in item) || item.instance) return;
      const r = await toggleProfile(services, part, latest.current.profiles, item.key);
      if (!r) return;
      if ('hint' in r) {
        setHint(r.hint);
        return;
      }
      setHint(null);
      // Against the profiles as they are now: another click's pick may have landed meanwhile.
      setProfiles((now) => r.toggle(now));
    },
    [part, services],
  );

  const pickFace = useCallback(
    async (item: SelectionItem | null, slot: 'face' | 'face2' | 'startFace') => {
      if (!setup || !item) return;
      // Picked in the state the extrude starts from: before it, when the shown evaluation holds it.
      const holdsIt = displayStore.getState().preview || setup.target.base !== undefined;
      const picked = await services.pick(item, holdsIt ? { before: setup.target.feature } : {});
      if (!picked || isPickedRegion(picked)) return;
      const entity = 'key' in item ? displayStore.getState().display?.entities[item.key] : undefined;
      const label =
        'standard' in item
          ? `${item.standard.toUpperCase()} plane`
          : entity?.kind === 'plane'
            ? String(findFeature(editor.document, entity.feature)?.name ?? 'Plane')
            : 'Face';
      const ref = { ...picked, label };
      setForm((f) =>
        slot === 'face'
          ? { ...f, extent: 'toFace', face: ref }
          : slot === 'face2'
            ? { ...f, side2: { ...(f.side2 ?? newSide()), extent: 'toFace', face: ref } }
            : { ...f, startFace: ref },
      );
      if (slot !== 'startFace')
        setToChoice((c) => ({
          ...c,
          [slot]: 'standard' in item ? item.standard : entity?.kind === 'plane' ? `cp:${entity.feature}` : 'face',
        }));
      setArmed('profiles');
      setError(null);
    },
    [setup, displayStore, services, editor],
  );

  const pickTarget = useCallback(
    async (item: SelectionItem | null) => {
      if (!setup || !item) return;
      const r = await toggleTarget(services, setup.target, item);
      if ('hint' in r) setHint(r.hint);
      else {
        setHint(null);
        setForm((f) => ({ ...f, targets: r.toggle(f.targets ?? []) }));
      }
    },
    [setup, services],
  );

  // The arrow that drags the first side's distance.
  const handle = useDistanceHandle(viewport, display, part, form, profiles, (distance) => {
    setForm((f) => ({ ...f, distance }));
    setError(null);
  });

  // Viewport clicks pick for the panel rather than selecting.
  useEffect(() => {
    if (!viewport) return;
    return takeClicks(
      services,
      viewport,
      (item) => {
        const slot = latest.current.armed;
        if (slot === 'face' || slot === 'face2' || slot === 'startFace') void pickFace(item, slot);
        else if (slot === 'targets') void pickTarget(item);
        else void pickProfile(item);
      },
      handle,
    );
  }, [services, viewport, pickFace, pickProfile, pickTarget, handle]);

  // The preview follows the form, a moment after it changes; the committed display returns on close.
  // A form that cannot build shows the state before the extrude at once.
  useEffect(() => {
    if (!setup) return;
    const built = buildExtrude(editor.document, setup.target, form, profiles, values);
    if (!built.ok) scheduler.setPreview(null);
    const timer = setTimeout(() => {
      if (!built.ok) {
        // A pick still to make waits without an error.
        const quiet =
          built.field === 'profiles' ||
          built.field === 'face' ||
          built.field === 'face2' ||
          built.field === 'startFace';
        setError(quiet ? null : { message: built.message, field: built.field ?? null });
        return;
      }
      const candidate = candidateDocument(editor.document, setup.target, built, profiles, (kind) => editor.newId(kind));
      setError(candidate.ok ? null : { message: candidate.message, field: null });
      scheduler.setPreview(candidate.ok ? candidate.doc : null);
    }, PREVIEW_DELAY);
    return () => clearTimeout(timer);
  }, [setup, form, profiles, values, editor, scheduler, doc]);
  useEffect(() => () => scheduler.setPreview(null), [scheduler]);

  // Why OK cannot write the form yet, by the check the preview and OK make; OK's tooltip.
  const blocked = useMemo(() => {
    if (!setup) return null;
    const built = buildExtrude(editor.document, setup.target, form, profiles, values);
    return built.ok ? null : built.message;
  }, [setup, form, profiles, values, editor]);

  const confirm = useCallback(() => {
    if (!setup) return;
    const built = buildExtrude(editor.document, setup.target, form, profiles, values);
    if (!built.ok) {
      setError({ message: built.message, field: built.field ?? null });
      if (built.field === 'face' || built.field === 'face2' || built.field === 'startFace') setArmed(built.field);
      return;
    }
    const result = writeExtrude(editor, setup.target, built, profiles);
    if (!result.ok) {
      setError({ message: result.error.message, field: null });
      return;
    }
    close();
  }, [setup, editor, form, profiles, values, close]);

  if (!setup) return null;

  const set = (patch: Partial<ExtrudeForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
  };
  const okBlocked = blocked ?? error?.message ?? null;
  const errorAt = (field: ExtrudeField | null) => (
    <ErrorLine message={error && error.field === field ? error.message : null} />
  );
  // The construction planes of the part before this extrude, with the key the display shows each by.
  const constructionPlanes = (() => {
    const rows = partOf(editor.document, setup.target.part)?.timeline;
    return (Array.isArray(rows) ? (rows as { id: string; type: string; name?: string }[]) : [])
      .filter((r) => r.type === 'core.constructionPlane' && standsBefore(editor.document, setup.target, r.id))
      .map((r) => ({
        id: r.id,
        name: String(r.name ?? 'Plane'),
        key: display?.entities.find((e) => e?.kind === 'plane' && e.feature === r.id)?.key ?? null,
      }));
  })();
  const chooseTo = (slot: 'face' | 'face2', choice: string, side: SideView) => {
    setToChoice((c) => ({ ...c, [slot]: choice }));
    if (choice === 'face') {
      if (toChoice[slot] !== 'face') side.set({ face: null });
      setArmed(slot);
      return;
    }
    setArmed('profiles');
    if (choice === 'xy' || choice === 'xz' || choice === 'yz') void pickFace({ standard: choice }, slot);
    else {
      const key = constructionPlanes.find((p) => `cp:${p.id}` === choice)?.key;
      if (key !== null && key !== undefined) void pickFace({ key }, slot);
    }
  };
  const sketchName = (() => {
    const id = profilesSketch(profiles) ?? request.from;
    const name = id ? findFeature(editor.document, id)?.name : undefined;
    return typeof name === 'string' ? name : 'Sketch';
  })();
  const mode = form.sides ?? 'one';
  const startType =
    form.startType ?? (form.startOffset !== undefined && fieldText(form.startOffset) !== '0' ? 'offset' : 'profile');

  const first: SideView = {
    side: { extent: form.extent, distance: form.distance, face: form.face, offset: form.offset, taper: form.taper },
    slot: 'face',
    fields: { distance: 'distance', face: 'face', offset: 'offset', taper: 'taper' },
    set: (patch) => set(patch),
  };
  const second: SideView = {
    side: form.side2 ?? newSide(),
    slot: 'face2',
    fields: { distance: 'second', face: 'face2', offset: 'offset2', taper: 'taper2' },
    set: (patch) => {
      setForm((f) => ({ ...f, side2: { ...(f.side2 ?? newSide()), ...patch } }));
      setError(null);
    },
  };

  const sideBlock = (view: SideView, autoFocus: boolean) => {
    const { side, slot, fields } = view;
    const object = side.extent === 'toFace' || side.extent === 'toBody';
    return (
      <>
        <Select
          label="Extent"
          value={side.extent === 'toBody' ? 'toFace' : side.extent}
          options={EXTENT_OPTIONS}
          onChange={(extent) => {
            view.set(extent === 'toFace' && side.extent === 'toBody' ? {} : { extent });
            setArmed(extent === 'toFace' && !side.face ? slot : 'profiles');
          }}
        />
        {side.extent === 'distance' && (
          <ExprField
            label="Distance"
            value={side.distance}
            unit="mm"
            onChange={(distance) => view.set({ distance })}
            onEnter={confirm}
            invalid={error?.field === fields.distance}
            autoFocus={autoFocus}
            placeholder="10"
          />
        )}
        {side.extent === 'distance' && errorAt(fields.distance)}
        {side.extent === 'toFace' && (
          <Row label="To">
            <select
              value={toChoice[slot]}
              onChange={(e) => chooseTo(slot, e.target.value, view)}
              style={styles.select}
              aria-label={slot === 'face' ? 'Extrude up to' : 'Side 2 up to'}
            >
              <option value="face">Face</option>
              <option value="xy">XY plane</option>
              <option value="xz">XZ plane</option>
              <option value="yz">YZ plane</option>
              {constructionPlanes.map((p) => (
                <option key={p.id} value={`cp:${p.id}`} disabled={p.key === null}>
                  {p.name}
                </option>
              ))}
            </select>
          </Row>
        )}
        {object && (
          <FaceSlot
            face={side.face}
            armed={armed === slot}
            emptyHint="Click the face or plane to extrude to"
            onArm={() => setArmed(slot)}
            onClear={() => {
              view.set({ face: null, extent: 'toFace' });
              setArmed(slot);
            }}
            clearTitle="Remove end face"
          />
        )}
        {object && errorAt(fields.face)}
        {side.extent === 'toFace' && (
          <ExprField
            label="Offset"
            value={side.offset ?? '0'}
            unit="mm"
            onChange={(offset) => view.set({ offset })}
            onEnter={confirm}
            invalid={error?.field === fields.offset}
          />
        )}
        {side.extent === 'toFace' && errorAt(fields.offset)}
        <ExprField
          label="Taper angle"
          value={side.taper ?? '0'}
          unit="°"
          onChange={(taper) => view.set({ taper })}
          onEnter={confirm}
          invalid={error?.field === fields.taper}
        />
        {errorAt(fields.taper)}
      </>
    );
  };

  return (
    <PanelCard title="Extrude" icon={<ExtrudeIcon size={14} color="#1a6fd1" />} onClose={close}>
      <ProfileRow
        profiles={profiles}
        sketchName={sketchName}
        onActivate={() => setArmed('profiles')}
        onRemove={(index) => {
          setProfiles((now) => now.filter((_, i) => i !== index));
          setError(null);
        }}
      />
      {hint && <div style={styles.note}>{hint}</div>}
      {errorAt('profiles')}

      <Select
        label="Start"
        value={startType}
        options={START_OPTIONS}
        onChange={(next) => {
          set({ startType: next, ...(next === 'profile' ? { startOffset: '0' } : {}) });
          setArmed(next === 'face' && !form.startFace ? 'startFace' : 'profiles');
        }}
      />
      {startType === 'face' && (
        <FaceSlot
          face={form.startFace ?? null}
          armed={armed === 'startFace'}
          emptyHint="Click the face or plane to start from"
          onArm={() => setArmed('startFace')}
          onClear={() => {
            set({ startFace: null });
            setArmed('startFace');
          }}
          clearTitle="Remove start face"
        />
      )}
      {startType === 'face' && errorAt('startFace')}
      {startType !== 'profile' && (
        <ExprField
          label="Offset"
          value={form.startOffset ?? '0'}
          unit="mm"
          onChange={(startOffset) => set({ startOffset })}
          onEnter={confirm}
          invalid={error?.field === 'startOffset'}
          placeholder="0"
        />
      )}
      {errorAt('startOffset')}

      <ToggleRow
        label="Direction"
        value={mode}
        options={SIDE_OPTIONS}
        onChange={(sides) =>
          set({
            sides,
            ...(sides === 'symmetric' ? { extent: 'distance' as const } : {}),
            ...(sides === 'two' && !form.side2 ? { side2: newSide() } : {}),
          })
        }
      />
      {mode === 'symmetric' ? (
        <>
          <ToggleRow
            label="Measure"
            value={form.measure ?? 'total'}
            options={MEASURE_OPTIONS}
            bound={values.boundText(['sides', 0, 'extent', 'symmetric', 'measure'], form.measure ?? 'total')}
            onChange={(measure) => set({ measure })}
          />
          <ExprField
            label="Distance"
            value={form.distance}
            unit="mm"
            onChange={(distance) => set({ distance })}
            onEnter={confirm}
            invalid={error?.field === 'distance'}
            autoFocus
            placeholder="10"
          />
          {errorAt('distance')}
          <ExprField
            label="Taper angle"
            value={form.taper ?? '0'}
            unit="°"
            onChange={(taper) => set({ taper })}
            onEnter={confirm}
            invalid={error?.field === 'taper'}
          />
          {errorAt('taper')}
        </>
      ) : (
        <>
          {mode === 'two' && <div style={sideHeading}>Side 1</div>}
          {sideBlock(first, true)}
          {mode === 'two' && <div style={sideHeading}>Side 2</div>}
          {mode === 'two' && sideBlock(second, false)}
        </>
      )}

      <Check
        label="Flip"
        checked={form.reversed}
        bound={values.boundText(['direction', 'normal', 'reversed'], form.reversed)}
        onChange={(reversed) => {
          setFlippedByHand(true);
          set({ reversed });
        }}
      />

      <ToggleRow
        label="Operation"
        value={form.operation}
        options={OPERATION_OPTIONS}
        bound={values.boundText(['operation', 'op'], form.operation)}
        onChange={(operation) => set({ operation })}
      />

      {form.operation !== 'new' && (
        <TargetBodies
          targets={form.targets ?? []}
          armed={armed === 'targets'}
          onArm={() => setArmed('targets')}
          onChange={(targets) => set({ targets })}
        />
      )}

      {errorAt(null)}
      {!error && <ErrorLine message={pausedLine(paused)} />}
      <Actions onCancel={close} onOk={confirm} blocked={okBlocked} />
    </PanelCard>
  );
}

const sideHeading: React.CSSProperties = {
  ...styles.sectionLabel,
  padding: '6px 12px 0',
  marginBottom: 0,
  borderTop: '1px solid #f0f0f0',
};

function FaceSlot({
  face,
  armed,
  emptyHint,
  onArm,
  onClear,
  clearTitle,
}: {
  face: { label: string; missing?: boolean } | null;
  armed: boolean;
  emptyHint: string;
  onArm: () => void;
  onClear: () => void;
  clearTitle: string;
}) {
  return (
    <div style={{ padding: '0 12px 6px' }}>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={armed}
        style={{
          ...styles.pickBox,
          borderColor: armed ? '#a8cef0' : '#eee',
          background: armed ? '#f0f7fe' : '#fafafa',
        }}
        onClick={onArm}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onArm();
          }
        }}
      >
        {face ? (
          <div style={styles.pickRow}>
            <span style={face.missing ? { ...styles.pickLabel, color: MISSING_COLOR } : styles.pickLabel}>
              {face.label}
            </span>
            <button
              type="button"
              style={styles.pickRemove}
              title={clearTitle}
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
            >
              <X size={11} />
            </button>
          </div>
        ) : (
          <div style={styles.emptyHint}>{emptyHint}</div>
        )}
      </div>
    </div>
  );
}

/**
 * The arrow at the end of the first side that drags its distance: a drag
 * writes the distance field as it goes, and the preview follows the field.
 * Returns whether it is being dragged, so its drags do not click.
 */
function useDistanceHandle(
  viewport: Viewport | null,
  display: Display | null,
  part: string | null,
  form: ExtrudeForm,
  profiles: readonly ExtrudeProfile[],
  onDistance: (text: string) => void,
): () => boolean {
  return useArrowHandle(viewport, part ? distanceArrow(display, part, form, profiles) : null, onDistance);
}
