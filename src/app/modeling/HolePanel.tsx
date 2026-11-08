/**
 * The Hole panel: click a planar face where the
 * hole goes (more clicks on the same face add positions, each with its x
 * and y in the face's frame), then the kind (simple, counterbore,
 * countersink), the diameter or a tapped thread size from the thread
 * table, and the depth (blind with a flat or drill-point tip, or through
 * all). The preview follows the form.
 *
 * A position snaps to the centre of a circular edge when the pointer is
 * near the edge or its centre, to a shown sketch point, or to the face
 * frame's origin; a marker shows where while the pointer hovers.
 *
 * After a position is placed, clicking straight edges of the face (up to two)
 * measures it from them (References): each edge gets a distance, at first the
 * one the position has, and the hole follows the edges when the face changes.
 * Clicking such an edge again drops it. The distances show on the face as
 * lines to the edges.
 */
import { useEffect, useRef, useState } from 'react';
import type { FrameDisplay, Vec3 } from '@tweakcad/worker/src/v2/service/types';
import type { SelectionItem } from '../selection';
import { X } from 'lucide-react';
import { HoleIcon } from '../../icons/cadIcons.tsx';
import type { PanelProps } from '../AppShell';
import {
  buildHole,
  clickEdge,
  clickFace,
  MAX_EDGES,
  newHoleForm,
  readHole,
  removeFace,
  tapDrill,
  type HoleForm,
  type HoleKind,
  type HolePosition,
} from './hole';
import { HoleDimensions } from './holeDimensions';
import { distanceFrom, edgeLineOf, footOn, shownAt, type EdgeLine } from './holeEdges';
import { fromFrame, SNAP_PIXELS, snapOnFace } from './holeSnap';
import { sameReference } from './feature';
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
  styles,
} from './panelKit';
import { kindOf, pickFor, planarFrame } from './picks';
import { SnapMarker } from './snapMarker';
import { ThreadSizeRows } from './ThreadSizeRows';
import { HANDS, INTERNAL_CLASSES } from './thread';
import { keysOf, useClicks, useFeaturePanel, usePicking, useShownPicks, type PanelSpec } from './usePanel';

const SPEC: PanelSpec<HoleForm> = {
  type: 'core.hole',
  baseName: 'Hole',
  create: newHoleForm,
  read: readHole,
  build: buildHole,
};

const KINDS: { id: HoleKind; label: string; title: string }[] = [
  { id: 'simple', label: 'Simple', title: 'A plain drilled hole' },
  { id: 'counterbore', label: "C'bore", title: 'Counterbore' },
  { id: 'countersink', label: "C'sink", title: 'Countersink' },
];

const EXTENTS = [
  { id: 'distance' as const, label: 'Blind', title: 'To a depth' },
  { id: 'throughAll' as const, label: 'Through', title: 'Through all' },
];

const TIPS = [
  { id: 'flat' as const, label: 'Flat' },
  { id: 'angle' as const, label: 'Drill point' },
];

const CLASSES = INTERNAL_CLASSES.map((c) => ({ id: c, label: c }));

/** Millimetres to two decimals, as a field shows them. */
const round = (n: number): string => String(Math.round(n * 100) / 100);

export function HolePanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const panel = useFeaturePanel(props, SPEC);
  const [hint, setHint] = useState<string | null>(null);
  // The position edges clicked next measure; the last one placed unless another is chosen.
  const [active, setActive] = useState<string | null>(null);
  usePicking(services, { kinds: ['face', 'edge'], standardPlanes: false });
  const edgeRefs = (panel?.form.positions ?? []).flatMap((p) => (p.from ?? []).map((f) => f.edge.reference));
  useShownPicks(
    services,
    panel?.target.part ?? null,
    panel?.form.face ? [panel.form.face.reference, ...edgeRefs] : edgeRefs,
  );

  // The placement frame of each face asked about, for the display it was read from.
  const frames = useRef(new Map<string, Promise<FrameDisplay | null>>());
  const frameOf = (item: Extract<SelectionItem, { key: number }>): Promise<FrameDisplay | null> => {
    const id = `${services.display.getState().display?.generation ?? -1}:${item.key}:${JSON.stringify(item.instance ?? null)}`;
    let frame = frames.current.get(id);
    if (!frame) {
      // In the frame the scene shows: a face of another part edited in context is read where this part sees it.
      frame = planarFrame(services, item).catch(() => null);
      frames.current.set(id, frame);
    }
    return frame;
  };
  const marker = useRef<SnapMarker | null>(null);
  useEffect(() => {
    if (!viewport) return;
    const m = new SnapMarker(viewport.getScene());
    marker.current = m;
    return () => {
      m.dispose();
      marker.current = null;
      viewport.requestRender();
    };
  }, [viewport]);
  // The hole's face as the viewport shows it, and the lines of a position's edges on it.
  const shownFace = async (): Promise<{ key: number; frame: FrameDisplay } | null> => {
    const face = panel?.latest.current.face;
    if (!panel || !face) return null;
    const item = (await keysOf(services, panel.target.part, [face.reference]).catch(() => [])).find(
      (i) => 'key' in i && i.instance === undefined,
    );
    const frame = item && 'key' in item ? await frameOf(item) : null;
    return item && 'key' in item && frame ? { key: item.key, frame } : null;
  };
  const edgeLines = async (
    face: { key: number; frame: FrameDisplay },
    p: HolePosition,
  ): Promise<(EdgeLine | null)[]> => {
    if (!panel) return [];
    const out: (EdgeLine | null)[] = [];
    for (const f of p.from ?? []) {
      const item = (await keysOf(services, panel.target.part, [f.edge.reference]).catch(() => [])).find(
        (i) => 'key' in i,
      );
      out.push(
        item && 'key' in item ? edgeLineOf(services.display.getState().display, item.key, face.key, face.frame) : null,
      );
    }
    return out;
  };

  const dimensions = useRef<HoleDimensions | null>(null);
  useEffect(() => {
    if (!viewport) return;
    const d = new HoleDimensions(viewport.getScene());
    dimensions.current = d;
    return () => {
      d.dispose();
      dimensions.current = null;
      viewport.requestRender();
    };
  }, [viewport]);
  const measuredKey = JSON.stringify([
    panel?.form.face?.reference ?? null,
    (panel?.form.positions ?? []).filter((p) => (p.from ?? []).length > 0),
  ]);
  useEffect(() => {
    let run = 0;
    const draw = async () => {
      const mine = ++run;
      const positions = panel?.latest.current.positions ?? [];
      const face = positions.some((p) => (p.from ?? []).length > 0) ? await shownFace() : null;
      const segments: [Vec3, Vec3][] = [];
      for (const p of face ? positions : []) {
        if (!face || (p.from ?? []).length === 0) continue;
        const lines = await edgeLines(face, p);
        const uv = shownAt(p, lines);
        if (!uv) continue;
        for (const line of lines)
          if (line) segments.push([fromFrame(face.frame, uv), fromFrame(face.frame, footOn(line, uv))]);
      }
      if (mine !== run) return;
      dimensions.current?.show(segments);
      viewport?.requestRender();
    };
    void draw();
    const off = services.display.subscribe((s, prev) => {
      if (s.display !== prev.display) void draw();
    });
    return () => {
      run++;
      off();
    };
    // Redrawn for the face and the measured positions, by their content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measuredKey, viewport, services]);

  /** A click on an edge: the active position is measured from it, or no longer, if it already was. */
  const clickOnEdge = async (item: Extract<SelectionItem, { key: number }>) => {
    if (!panel) return;
    const form = panel.latest.current;
    const position = form.positions.find((p) => p.id === active) ?? form.positions[form.positions.length - 1];
    if (!form.face || !position) {
      setHint('Click on the face where the hole goes');
      return;
    }
    const picked = await pickFor(services, panel.target, item);
    if (!picked) {
      setHint('That edge is made by this hole; pick another');
      return;
    }
    const again = (position.from ?? []).some((f) => sameReference(f.edge.reference, picked.reference));
    let distance = '0';
    if (!again) {
      const face = await shownFace();
      const line = face && edgeLineOf(services.display.getState().display, item.key, face.key, face.frame);
      if (!face || !line) {
        setHint('Click a straight edge of the hole face');
        return;
      }
      if ((position.from ?? []).length >= MAX_EDGES) {
        setHint('A position is measured from two edges at most');
        return;
      }
      const uv = shownAt(position, await edgeLines(face, position));
      distance = uv ? round(distanceFrom(line, uv)) : '0';
    }
    setHint(null);
    setActive(position.id);
    panel.update((f) => ({
      positions: f.positions.map((p) => (p.id === position.id ? clickEdge(p, picked, distance) : p)),
    }));
  };

  const hover = useRef(0);
  const hideMarker = () => {
    if (!marker.current?.shown) return;
    marker.current.hide();
    viewport?.requestRender();
  };

  useClicks(
    services,
    viewport,
    (item, e) => {
      hideMarker();
      if (!panel || !viewport || !item || !('key' in item)) return;
      if (kindOf(services.display.getState().display, item) === 'edge') {
        void clickOnEdge(item);
        return;
      }
      if (kindOf(services.display.getState().display, item) !== 'face') {
        setHint('Click a flat face of a body');
        return;
      }
      void (async () => {
        const frame = await frameOf(item);
        if (!frame) {
          setHint('This face is not flat');
          return;
        }
        const picked = await pickFor(services, panel.target, item);
        if (!picked) {
          setHint('That face is made by this hole; pick another');
          return;
        }
        const hit = viewport.planePoint(e.clientX, e.clientY, frame);
        const at = hit
          ? snapOnFace(services.display.getState().display, item, frame, hit.uv, SNAP_PIXELS * hit.pixel).uv
          : [0, 0];
        const position: HolePosition = { id: services.editor.newId('hp'), x: round(at[0] ?? 0), y: round(at[1] ?? 0) };
        // The hole's face is lost when it lands on nothing the viewport shows.
        const stored = panel.form.face;
        const faceLost =
          stored !== null &&
          (await keysOf(services, panel.target.part, [stored.reference]).catch(() => [])).length === 0;
        setHint(null);
        setActive(position.id);
        panel.update((f) => clickFace(f, picked, position, faceLost));
      })();
    },
    undefined,
    (e) => {
      // Where a click would snap: the marker follows the pointer over flat faces.
      const mine = ++hover.current;
      const item = viewport?.pickAt(e.clientX, e.clientY) ?? null;
      const display = services.display.getState().display;
      if (!viewport || !item || !('key' in item) || kindOf(display, item) !== 'face') {
        hideMarker();
        return;
      }
      void frameOf(item).then((frame) => {
        if (mine !== hover.current || !marker.current) return;
        const hit = frame && viewport.planePoint(e.clientX, e.clientY, frame);
        const snap =
          frame && hit
            ? snapOnFace(services.display.getState().display, item, frame, hit.uv, SNAP_PIXELS * hit.pixel)
            : null;
        if (!frame || !hit || !snap?.target) {
          hideMarker();
          return;
        }
        marker.current.show(fromFrame(frame, snap.uv), frame.normal, hit.pixel);
        viewport.requestRender();
      });
    },
  );

  if (!panel) return null;
  const { form } = panel;
  const set = (patch: Partial<HoleForm>) => panel.update(patch);
  const setPosition = (i: number, patch: Partial<HolePosition>) =>
    set({ positions: form.positions.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const setDistance = (i: number, j: number, distance: string) =>
    setPosition(i, { from: (form.positions[i]?.from ?? []).map((f, k) => (k === j ? { ...f, distance } : f)) });
  const dropEdge = (i: number, j: number) => {
    const p = form.positions[i];
    if (p?.from?.[j]) setPosition(i, clickEdge(p, p.from[j].edge, ''));
  };
  const activeId = form.positions.some((p) => p.id === active)
    ? active
    : (form.positions[form.positions.length - 1]?.id ?? null);
  const drill = form.threaded ? tapDrill(form.designation) : null;
  const bound = (path: string[], shown: string | boolean) => panel.values.boundText(path, shown);

  return (
    <PanelCard title="Hole" icon={<HoleIcon size={14} color="#f97316" />} onClose={close}>
      <PickList
        label="Face"
        single
        items={form.face ? [form.face] : form.keptPlacement ? [{ label: 'Placement frame' }] : []}
        armed
        onRemove={() => set(removeFace())}
        empty="Click a flat face where the hole goes"
      />
      <div style={styles.section}>
        <div style={styles.sectionLabel}>Positions {form.positions.length > 0 ? `(${form.positions.length})` : ''}</div>
        {form.positions.length === 0 && <div style={styles.emptyHint}>Click on the face</div>}
        {form.positions.map((p, i) => (
          <div key={p.id}>
            <div style={{ ...styles.pickRow, gap: 4 }}>
              <button
                type="button"
                title="Measure this position from the edges clicked next"
                style={{
                  ...styles.pickIndex,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  ...(p.id === activeId && form.positions.length > 1 ? { color: '#f97316', fontWeight: 700 } : {}),
                }}
                onClick={() => setActive(p.id)}
              >
                {i + 1}
              </button>
              {(p.from ?? []).length >= MAX_EDGES ? (
                <span style={{ ...styles.unit, flex: 1 }}>From edges</span>
              ) : p.kept ? (
                <span style={{ ...styles.unit, flex: 1 }}>Linked point</span>
              ) : (
                <>
                  <span style={styles.unit}>X</span>
                  <input
                    aria-label={`Position ${i + 1} x`}
                    style={{ ...styles.input, width: 70, height: 24 }}
                    value={p.x}
                    onChange={(e) => setPosition(i, { x: e.target.value })}
                  />
                  <span style={styles.unit}>Y</span>
                  <input
                    aria-label={`Position ${i + 1} y`}
                    style={{ ...styles.input, width: 70, height: 24 }}
                    value={p.y}
                    onChange={(e) => setPosition(i, { y: e.target.value })}
                  />
                </>
              )}
              <button
                type="button"
                style={styles.pickRemove}
                title="Remove"
                onClick={() => set({ positions: form.positions.filter((_, j) => j !== i) })}
              >
                <X size={11} />
              </button>
            </div>
            {(p.from ?? []).map((f, j) => (
              <div key={j} style={{ ...styles.pickRow, gap: 4, paddingLeft: 18 }}>
                <span
                  style={{
                    ...styles.unit,
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={f.edge.label}
                >
                  {f.edge.label}
                </span>
                <input
                  aria-label={`Position ${i + 1} distance ${j + 1}`}
                  style={{ ...styles.input, width: 70, height: 24 }}
                  value={f.distance}
                  onChange={(e) => setDistance(i, j, e.target.value)}
                />
                <span style={styles.unit}>mm</span>
                <button type="button" style={styles.pickRemove} title="Remove" onClick={() => dropEdge(i, j)}>
                  <X size={11} />
                </button>
              </div>
            ))}
            {p.id === activeId && (p.from ?? []).length === 0 && form.face && (
              <div style={{ ...styles.emptyHint, paddingLeft: 18 }}>Click edges of the face to measure from</div>
            )}
          </div>
        ))}
      </div>
      <Note message={hint} />
      <ToggleRow
        label="Type"
        value={form.kind}
        options={KINDS}
        bound={bound(['kind'], form.kind)}
        onChange={(kind) => set({ kind })}
      />
      <Check label="Tapped" checked={form.threaded} onChange={(threaded) => set({ threaded })} />
      {form.threaded ? (
        <>
          <ThreadSizeRows
            designation={form.designation}
            bound={bound(['thread', 'thread', 'designation'], form.designation)}
            onChange={(designation) => set({ designation })}
          />
          <Select
            label="Class"
            value={form.threadClass}
            options={CLASSES}
            bound={bound(['thread', 'thread', 'class'], form.threadClass)}
            onChange={(threadClass) => set({ threadClass })}
          />
          <ToggleRow
            label="Direction"
            value={form.hand}
            options={HANDS}
            bound={bound(['thread', 'thread', 'hand'], form.hand)}
            onChange={(hand) => set({ hand })}
          />
          <Check
            label="Modeled"
            checked={form.modelled}
            bound={bound(['thread', 'thread', 'modelled'], form.modelled)}
            onChange={(modelled) => set({ modelled })}
          />
          {drill !== null && (
            <Row label="Drill">
              <span style={{ fontSize: 12, color: '#555' }}>{drill} mm</span>
            </Row>
          )}
        </>
      ) : (
        <ExprField
          label="Diameter"
          value={form.diameter}
          unit="mm"
          onChange={(diameter) => set({ diameter })}
          onEnter={panel.confirm}
          autoFocus
        />
      )}
      {form.kind === 'counterbore' && (
        <>
          <ExprField
            label="C'bore Ø"
            value={form.counterboreDiameter}
            unit="mm"
            onChange={(counterboreDiameter) => set({ counterboreDiameter })}
            onEnter={panel.confirm}
          />
          <ExprField
            label="C'bore depth"
            value={form.counterboreDepth}
            unit="mm"
            onChange={(counterboreDepth) => set({ counterboreDepth })}
            onEnter={panel.confirm}
          />
        </>
      )}
      {form.kind === 'countersink' && (
        <>
          <ExprField
            label="C'sink Ø"
            value={form.countersinkDiameter}
            unit="mm"
            onChange={(countersinkDiameter) => set({ countersinkDiameter })}
            onEnter={panel.confirm}
          />
          <ExprField
            label="C'sink angle"
            value={form.countersinkAngle}
            unit="°"
            onChange={(countersinkAngle) => set({ countersinkAngle })}
            onEnter={panel.confirm}
          />
        </>
      )}
      {form.extent !== 'kept' && (
        <ToggleRow label="Extent" value={form.extent} options={EXTENTS} onChange={(extent) => set({ extent })} />
      )}
      {form.extent === 'distance' && (
        <>
          <ExprField
            label="Depth"
            value={form.depth}
            unit="mm"
            onChange={(depth) => set({ depth })}
            onEnter={panel.confirm}
          />
          <ToggleRow label="Tip" value={form.tip} options={TIPS} onChange={(tip) => set({ tip })} />
          {form.tip === 'angle' && (
            <ExprField
              label="Tip angle"
              value={form.tipAngle}
              unit="°"
              onChange={(tipAngle) => set({ tipAngle })}
              onEnter={panel.confirm}
            />
          )}
        </>
      )}
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} blocked={panel.blocked} />
    </PanelCard>
  );
}
