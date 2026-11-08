/**
 * The sketch's constraint glyphs as HTML badges over the viewport, placed
 * every frame through `project`, beside the geometry they hold. A click selects the constraint (Shift adds to the
 * selection); Delete then removes it, as for any selection.
 */
import { useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react';
import {
  CoincidentConstraintIcon,
  CollinearConstraintIcon,
  ConcentricConstraintIcon,
  EqualConstraintIcon,
  FixConstraintIcon,
  HorizontalConstraintIcon,
  MidpointConstraintIcon,
  OffsetToolIcon,
  ParallelConstraintIcon,
  PerpendicularConstraintIcon,
  SymmetryConstraintIcon,
  TangentConstraintIcon,
  VerticalConstraintIcon,
} from '../icons/cadIcons';
import type { Projection } from './DimensionLabels';
import { placeGlyphs } from './glyphs';
import type { SketchSession } from './session';

type Icon = (props: { size?: number; color?: string }) => ReactElement;

/** The palette's icon for each constraint kind a glyph shows. */
const ICONS: Record<string, Icon> = {
  horizontal: HorizontalConstraintIcon,
  vertical: VerticalConstraintIcon,
  parallel: ParallelConstraintIcon,
  perpendicular: PerpendicularConstraintIcon,
  equal: EqualConstraintIcon,
  tangent: TangentConstraintIcon,
  midpoint: MidpointConstraintIcon,
  pointOnCurve: CoincidentConstraintIcon,
  coincident: CoincidentConstraintIcon,
  fixed: FixConstraintIcon,
  block: FixConstraintIcon,
  concentric: ConcentricConstraintIcon,
  coradial: ConcentricConstraintIcon,
  collinear: CollinearConstraintIcon,
  symmetric: SymmetryConstraintIcon,
  offset: OffsetToolIcon,
};

/** Badge size and the gap between badges at one place, in pixels. */
const SIZE = 16;
const STEP = 18;

export interface ConstraintGlyphsProps {
  session: SketchSession;
  project: Projection;
}

export function ConstraintGlyphs({ session, project }: ConstraintGlyphsProps) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const glyphs = state.open ? session.glyphs() : [];
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const latest = useRef({ glyphs, project });
  useLayoutEffect(() => {
    latest.current = { glyphs, project };
  });

  useLayoutEffect(() => {
    let frame = 0;
    // The layout is worked out again only when the glyphs changed or an anchor moved on screen.
    let laidFor = '';
    let laidGlyphs: unknown = null;
    const place = () => {
      const shown = latest.current.glyphs.flatMap((g) => {
        const node = nodes.current.get(`${g.id}:${g.slot}:${g.at[0]},${g.at[1]}`);
        if (!node) return [];
        const at = latest.current.project(g.part);
        node.style.display = at ? '' : 'none';
        return at ? [{ node, at: { x: Math.round(at.x), y: Math.round(at.y) } }] : [];
      });
      const key = shown.map((s) => `${s.at.x},${s.at.y}`).join(';');
      if (key !== laidFor || latest.current.glyphs !== laidGlyphs) {
        laidFor = key;
        laidGlyphs = latest.current.glyphs;
        // Beside and below the anchor, or the nearest place clear of the badges before it.
        placeGlyphs(
          shown.map((s) => s.at),
          SIZE,
          STEP,
        ).forEach((p, i) => {
          (shown[i] as (typeof shown)[number]).node.style.transform = `translate(${p.x}px, ${p.y}px)`;
        });
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div style={styles.overlay}>
      {glyphs.map((g) => {
        const key = `${g.id}:${g.slot}:${g.at[0]},${g.at[1]}`;
        const Icon = ICONS[g.kind];
        const selected = state.selection.includes(g.id);
        return (
          <button
            key={key}
            type="button"
            title={g.kind}
            aria-label={`${g.kind} constraint`}
            data-constraint={g.id}
            ref={(node) => {
              if (node) nodes.current.set(key, node);
              else nodes.current.delete(key);
            }}
            style={{ ...styles.glyph, ...(selected ? styles.selected : {}) }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              session.select([g.id], e.shiftKey);
            }}
          >
            {Icon ? (
              <Icon size={12} color={selected ? '#92400e' : '#374151'} />
            ) : (
              <span style={styles.symbol}>{g.symbol}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  overlay: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5, overflow: 'hidden' },
  glyph: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: SIZE,
    height: SIZE,
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f3f4f6',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#9ca3af',
    borderRadius: 3,
    pointerEvents: 'auto',
    cursor: 'pointer',
  },
  selected: { background: '#fde68a', borderColor: '#f59e0b' },
  symbol: { fontSize: 10, fontWeight: 700, color: '#374151', lineHeight: 1 },
};
