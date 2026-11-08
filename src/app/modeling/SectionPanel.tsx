/**
 * The Section panel (Section Analysis): a non-destructive cut that clips the
 * bodies with a plane so you can see inside. The cut starts from a standard
 * plane, or from a flat face or construction plane clicked in the view;
 * Distance moves it along that plane's normal (the handle in the view drags
 * it too), Angle turns it about the plane's x axis, and Flip keeps the other
 * half. Done or Escape ends it.
 */
import { useEffect, useState } from 'react';
import { SquareSplitHorizontal } from 'lucide-react';
import { PanelHeader } from '../../components/PanelHeader.tsx';
import type { SectionOrientation, SectionView } from '../appState';
import { findFeature } from '../features';
import type { SelectionItem } from '../selection';
import type { AppServices } from '../services';
import type { Viewport } from '../viewport/Viewport';
import { Check, Note, Row, styles, Toggles, type ToggleOption } from './panelKit';
import { kindOf, planarFrame } from './picks';
import { takeClicks } from './viewportClicks';

type PlaneChoice = SectionOrientation | 'face';

const PLANES: ToggleOption<PlaneChoice>[] = [
  { id: 'XY', label: 'XY' },
  { id: 'XZ', label: 'XZ' },
  { id: 'YZ', label: 'YZ' },
  { id: 'face', label: 'Face', title: 'A flat face or a construction plane clicked in the view' },
];

/** The plane a click lands on, as the section starts from it; a hint when it is not a plane. */
export async function sectionPlaneAt(
  services: AppServices,
  item: SelectionItem | null,
): Promise<SectionView['plane'] | { hint: string }> {
  if (!item) return { hint: 'Click a flat face or a plane' };
  if ('standard' in item) return item.standard.toUpperCase() as SectionOrientation;
  const display = services.display.getState().display;
  const kind = kindOf(display, item);
  if (kind === 'plane' && 'key' in item) {
    const entity = display?.entities[item.key];
    const c = display?.definitions.flatMap((d) => d.construction).find((x) => x.key === item.key);
    if (c)
      return {
        label: String(findFeature(services.editor.document, entity?.feature ?? '')?.name ?? 'Plane'),
        origin: c.frame.origin,
        normal: c.frame.normal,
        x: c.frame.x,
      };
  }
  if (kind === 'face' && 'key' in item) {
    const frame = await planarFrame(services, item.key);
    if (frame) return { label: 'Face', origin: frame.origin, normal: frame.normal, x: frame.x };
    return { hint: 'This face is not flat' };
  }
  return { hint: 'Click a flat face or a plane' };
}

/** A number field that follows its value unless it is being typed in; a value that is not a number is not sent. */
function NumberField({
  label,
  value,
  unit,
  onChange,
}: {
  label: string;
  value: number | null;
  unit: string;
  onChange: (v: number) => void;
}) {
  // What is being typed, while the field has focus; otherwise the value shows.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? (value === null ? '' : String(value));
  const bad = text.trim() !== '' && !Number.isFinite(Number(text));
  return (
    <Row label={label}>
      <div style={styles.inputGroup}>
        <input
          type="text"
          aria-label={label}
          value={text}
          onFocus={() => setDraft(text)}
          onBlur={() => setDraft(null)}
          onChange={(e) => {
            setDraft(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(v)) onChange(v);
          }}
          style={{ ...styles.input, width: 80, borderColor: bad ? '#dc2626' : '#d0d0d0' }}
        />
        <span style={styles.unit}>{unit}</span>
      </div>
    </Row>
  );
}

export function SectionPanel({
  services,
  viewport,
  section,
  onDone,
}: {
  services: AppServices;
  viewport: Viewport | null;
  section: SectionView;
  onDone: () => void;
}) {
  const { app } = services;
  const [armed, setArmed] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const update = (patch: Partial<SectionView>) => {
    const now = app.getState().section;
    if (now) app.setState({ section: { ...now, ...patch } });
  };

  // While Face is armed, a click in the view picks the plane the cut starts from.
  useEffect(() => {
    if (!viewport || !armed) return;
    app.setState({ picking: { kinds: ['face', 'construction', 'standard'], standardPlanes: true } });
    const off = takeClicks(services, viewport, (item) => {
      void sectionPlaneAt(services, item).then((plane) => {
        if (typeof plane === 'object' && 'hint' in plane) {
          setHint(plane.hint);
          return;
        }
        setHint(null);
        setArmed(false);
        // On a face the cut keeps the body behind it: a face's normal points out of the body.
        update({ plane, distance: 0, angle: 0, flipped: typeof plane !== 'string' && plane.label === 'Face' });
      });
    });
    return () => {
      off();
      app.setState({ picking: null });
    };
    // `update` reads the store as it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, armed, services, app]);

  const choice: PlaneChoice = typeof section.plane === 'string' ? section.plane : 'face';
  return (
    <div style={styles.overlay}>
      <div style={{ ...styles.panel, width: 260 }}>
        <PanelHeader
          title="Section"
          icon={<SquareSplitHorizontal size={14} color="#059669" />}
          onClose={onDone}
          closeTitle="End section (Esc)"
        />
        <Row label="Plane">
          <Toggles
            value={armed ? 'face' : choice}
            options={PLANES}
            onChange={(id) => {
              setHint(null);
              if (id === 'face') {
                setArmed(true);
                return;
              }
              setArmed(false);
              update({ plane: id, distance: null, angle: 0 });
            }}
          />
        </Row>
        {(armed || typeof section.plane !== 'string') && (
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
              onClick={() => setArmed(true)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setArmed(true)}
            >
              {armed ? (
                <div style={styles.emptyHint}>Click a flat face or a plane</div>
              ) : (
                <div style={styles.pickRow}>
                  <span style={styles.pickLabel}>{typeof section.plane === 'string' ? '' : section.plane.label}</span>
                </div>
              )}
            </div>
          </div>
        )}
        <Note message={hint} />
        <NumberField
          label="Distance"
          value={section.distance}
          unit="mm"
          onChange={(distance) => update({ distance })}
        />
        <NumberField
          label="Angle"
          value={section.angle}
          unit="°"
          onChange={(angle) => update({ angle: Math.max(-89, Math.min(89, angle)) })}
        />
        <Check label="Flip" checked={section.flipped} onChange={(flipped) => update({ flipped })} />
        <div style={styles.actions}>
          <button type="button" style={styles.okBtn} onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
