/**
 * CAD-specific SVG icons for feature types, tools, and operations.
 *
 * Uses inline SVG for CAD-domain icons that don't exist in standard icon libraries.
 * Standard UI icons (undo, redo, zoom, settings) come from lucide-react.
 *
 * All icons follow a consistent 16x16 viewBox, stroke-based design
 * that matches the Lucide visual language.
 */

import type { CSSProperties, ReactElement } from 'react';

interface IconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}

const defaults: Required<Pick<IconProps, 'size' | 'color' | 'strokeWidth'>> = {
  size: 16,
  color: 'currentColor',
  strokeWidth: 0.75,
};

// ---- Sketch ----
/** Pencil on plane - represents 2D sketch creation */
export function SketchIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* Plane / grid base */}
      <path d="M2 12L8 15L14 12L8 9Z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
      {/* Pencil */}
      <path d="M5 8L10 3L12 5L7 10L4.5 10.5L5 8Z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
      <path d="M9 4L11 6" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  );
}

// ---- Extrude ----
/** Arrow pulling surface upward - represents extrusion */
export function ExtrudeIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* Base rectangle (profile) */}
      <rect x="3" y="10" width="10" height="4" rx="0.5" stroke={color} strokeWidth={strokeWidth} />
      {/* Extruded body */}
      <path d="M4 10V5M12 10V5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M4 5H12" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      {/* Up arrow */}
      <path d="M8 7V1M5.5 3.5L8 1L10.5 3.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- Plane (construction / datum) ----
/** Tilted parallelogram with a normal tick — represents a reference plane */
export function PlaneIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* Parallelogram (the plane in perspective) */}
      <path d="M2 10L6 4L14 4L10 10Z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
      {/* Normal indicator */}
      <path d="M8 7L8 13" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M6.5 11.5L8 13L9.5 11.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- Hole ----
/** Circle with downward arrow - represents hole/bore */
export function HoleIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* Circle (hole profile) */}
      <circle cx="8" cy="6" r="4" stroke={color} strokeWidth={strokeWidth} />
      {/* Down arrow (cut direction) */}
      <path d="M8 8V14M5.5 11.5L8 14L10.5 11.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      {/* Center crosshair */}
      <circle cx="8" cy="6" r="1" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  );
}

// ---- Cut (Boolean Subtract) ----
/** Two overlapping shapes with minus - represents boolean cut */
export function CutIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* Base shape */}
      <rect x="1" y="4" width="9" height="9" rx="1" stroke={color} strokeWidth={strokeWidth} />
      {/* Cutting shape (dashed) */}
      <rect x="6" y="1" width="9" height="9" rx="1" stroke={color} strokeWidth={strokeWidth} strokeDasharray="2 1.5" />
      {/* Minus sign */}
      <path d="M5 14.5H10" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

// ---- Fuse (Boolean Join) ----
/** Two overlapping shapes with plus - represents boolean union */
export function FuseIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* Shape A */}
      <rect x="1" y="4" width="9" height="9" rx="1" stroke={color} strokeWidth={strokeWidth} />
      {/* Shape B */}
      <rect x="6" y="1" width="9" height="9" rx="1" stroke={color} strokeWidth={strokeWidth} />
      {/* Plus sign */}
      <path d="M6.5 14.5H10M8.25 12.75V16.25" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

// ---- Pattern (Linear) ----
/** Three repeated shapes in a row */
export function PatternIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <rect x="1" y="5" width="3.5" height="6" rx="0.5" stroke={color} strokeWidth={strokeWidth} />
      <rect x="6.25" y="5" width="3.5" height="6" rx="0.5" stroke={color} strokeWidth={strokeWidth} />
      <rect x="11.5" y="5" width="3.5" height="6" rx="0.5" stroke={color} strokeWidth={strokeWidth} />
      {/* Arrow indicating repetition */}
      <path d="M3 3H13M11 1.5L13 3L11 4.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- Fillet ----
/** Corner with rounded edge */
export function FilletIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M3 2V8Q3 13 8 13H14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill="none" />
      {/* Radius indicator */}
      <path d="M3 8L8 13" stroke={color} strokeWidth={strokeWidth} strokeDasharray="1.5 1.5" />
      <circle cx="5.5" cy="10.5" r="0.8" fill={color} />
    </svg>
  );
}

// ---- Chamfer ----
/** Corner with angled cut */
export function ChamferIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M3 2V8L8 13H14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      {/* Chamfer line highlight */}
      <path d="M3 8L8 13" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      {/* Dimension markers */}
      <path d="M1 8H3M8 13V15" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

// ---- Mirror ----
/** Shape with dashed line and mirrored copy */
export function MirrorIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* Mirror line */}
      <path d="M8 1V15" stroke={color} strokeWidth={strokeWidth} strokeDasharray="2 1.5" />
      {/* Original shape */}
      <path d="M2 5L6 4L6 12L2 11Z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
      {/* Mirrored shape */}
      <path d="M14 5L10 4L10 12L14 11Z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" opacity="0.6" />
    </svg>
  );
}

// ---- Shell ----
/** Hollow box outline */
export function ShellIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* Outer box */}
      <rect x="2" y="3" width="12" height="10" rx="1" stroke={color} strokeWidth={strokeWidth} />
      {/* Inner cavity */}
      <rect x="4" y="3" width="8" height="7" rx="0.5" stroke={color} strokeWidth={strokeWidth} strokeDasharray="2 1" />
    </svg>
  );
}

// ---- Revolve ----
/** Profile with circular arrow */
export function RevolveIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* Profile shape */}
      <path d="M3 4V12H6V8H4V4Z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
      {/* Circular arrow for revolution */}
      <path d="M9 3C12 3 14 5.5 14 8C14 10.5 12 13 9 13" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill="none" />
      <path d="M10.5 11L9 13L10.5 15" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- Sketch Tool Icons ----

/** Hand/pointer cursor - Select tool */
export function SelectHandIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M7 1.5V9.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M7 9.5L4.5 7.5C4 7.1 3.2 7.2 3 7.8C2.8 8.4 3.1 8.9 3.5 9.2L7 12.5C7.5 13 8.5 13.5 9.5 13.5H10.5C12.5 13.5 13.5 12 13.5 10V7.5C13.5 7 13 6.5 12.5 6.5C12 6.5 11.5 7 11.5 7.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.5 7.5V6C11.5 5.5 11 5 10.5 5C10 5 9.5 5.5 9.5 6V6.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M9.5 6.5V5C9.5 4.5 9 4 8.5 4C8 4 7.5 4.5 7.5 5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

/** Diagonal line - Line tool */
export function LineToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line x1="3" y1="13" x2="13" y2="3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <circle cx="3" cy="13" r="1.2" fill={color} />
      <circle cx="13" cy="3" r="1.2" fill={color} />
    </svg>
  );
}

/** Rectangle outline - Rectangle tool */
export function RectToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <rect x="2" y="4" width="12" height="8" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
      <circle cx="2" cy="4" r="1" fill={color} />
      <circle cx="14" cy="4" r="1" fill={color} />
      <circle cx="14" cy="12" r="1" fill={color} />
      <circle cx="2" cy="12" r="1" fill={color} />
    </svg>
  );
}

/** Circle outline - Circle tool */
export function CircleToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <circle cx="8" cy="8" r="6" stroke={color} strokeWidth={strokeWidth} />
      <circle cx="8" cy="8" r="1" fill={color} />
    </svg>
  );
}

/** Arc curve - Arc tool */
export function ArcToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M3 12C3 6 6 3 13 3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill="none" />
      <circle cx="3" cy="12" r="1.2" fill={color} />
      <circle cx="13" cy="3" r="1.2" fill={color} />
    </svg>
  );
}

/** Pentagon - Polygon tool */
export function PolygonToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <polygon points="8,1.5 14,5.5 12,13 4,13 2,5.5" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** Ellipse outline */
export function EllipseToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <ellipse cx="8" cy="8" rx="7" ry="4.5" stroke={color} strokeWidth={strokeWidth} />
      <circle cx="8" cy="8" r="0.8" fill={color} />
    </svg>
  );
}

/** Slot / rounded rectangle */
export function SlotToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <rect x="1.5" y="5" width="13" height="6" rx="3" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  );
}

/** Spline / free-form curve */
export function SplineToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M2 12C4 4 7 14 10 6C11.5 2 14 3 14 5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill="none" />
      <circle cx="2" cy="12" r="1" fill={color} />
      <circle cx="14" cy="5" r="1" fill={color} />
    </svg>
  );
}

/** Small dot - Point tool */
export function PointToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <circle cx="8" cy="8" r="2.5" fill={color} />
      <line x1="8" y1="2" x2="8" y2="5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="8" y1="11" x2="8" y2="14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="2" y1="8" x2="5" y2="8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="11" y1="8" x2="14" y2="8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

/** Scissors - Trim tool */
export function TrimToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <circle cx="4" cy="4" r="2.5" stroke={color} strokeWidth={strokeWidth} />
      <circle cx="4" cy="12" r="2.5" stroke={color} strokeWidth={strokeWidth} />
      <line x1="6" y1="5.5" x2="14" y2="12" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="6" y1="10.5" x2="14" y2="4" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

/** Extend line tool */
export function ExtendToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line x1="2" y1="8" x2="10" y2="8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="10" y1="8" x2="14" y2="8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeDasharray="2 1.5" />
      <path d="M12 5.5L14.5 8L12 10.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Offset curves tool */
export function OffsetToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M3 4C3 4 5 12 11 12" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill="none" />
      <path d="M5 2C5 2 7 10 13 10" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill="none" strokeDasharray="2 1.5" />
      <path d="M4 3L5.5 1.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M7 8L8.5 6.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

/** Sketch fillet (2D corner rounding) */
export function SketchFilletToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M3 3V9Q3 13 7 13H13" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** Sketch mirror tool */
export function SketchMirrorToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M8 2V14" stroke={color} strokeWidth={strokeWidth} strokeDasharray="2 1.5" strokeLinecap="round" />
      <path d="M3 5L6 5L6 11L3 11Z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
      <path d="M13 5L10 5L10 11L13 11Z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" opacity="0.5" />
    </svg>
  );
}

/** Horizontal constraint */
export function HorizontalConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line x1="2" y1="8" x2="14" y2="8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M4 5.5L2 8L4 10.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 5.5L14 8L12 10.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Combined horizontal/vertical constraint (auto). */
export function HVConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* horizontal segment */}
      <line x1="2" y1="11" x2="10" y2="11" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M3.5 9L2 11L3.5 13" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      {/* vertical segment */}
      <line x1="11" y1="2" x2="11" y2="14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M9 3.5L11 2L13 3.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Vertical constraint */
export function VerticalConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line x1="8" y1="2" x2="8" y2="14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M5.5 4L8 2L10.5 4" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 12L8 14L10.5 12" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Perpendicular constraint (right angle symbol) */
export function PerpendicularConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line x1="2" y1="13" x2="14" y2="13" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="8" y1="13" x2="8" y2="2" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <rect x="8" y="9" width="3" height="3" stroke={color} strokeWidth={strokeWidth} fill="none" />
    </svg>
  );
}

/** Parallel constraint (two parallel lines) */
export function ParallelConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line x1="3" y1="13" x2="11" y2="3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="5" y1="13" x2="13" y2="3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

/** Tangent constraint — circle resting on a line (line is geometrically tangent). */
export function TangentConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  // Circle (cx=8, cy=7, r=4). Bottom of circle sits at y=11.
  // Line y=11 touches the circle at exactly one point (8, 11) → true tangency.
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <circle cx="8" cy="7" r="4" stroke={color} strokeWidth={strokeWidth} />
      <line x1="1" y1="11" x2="15" y2="11" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

/** Equal constraint (= sign) */
export function EqualConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line x1="3" y1="6" x2="13" y2="6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="3" y1="10" x2="13" y2="10" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

/** Concentric constraint — two circles sharing a centre. */
export function ConcentricConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <circle cx="8" cy="8" r="6" stroke={color} strokeWidth={strokeWidth} />
      <circle cx="8" cy="8" r="3" stroke={color} strokeWidth={strokeWidth} />
      <circle cx="8" cy="8" r="0.8" fill={color} />
    </svg>
  );
}

/** Midpoint constraint — line segment with a dot at its centre. */
export function MidpointConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line x1="2" y1="8" x2="14" y2="8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <circle cx="2" cy="8" r="1" fill={color} />
      <circle cx="14" cy="8" r="1" fill={color} />
      <circle cx="8" cy="8" r="1.8" fill={color} />
    </svg>
  );
}

/** Coincident constraint (overlapping dots) */
export function CoincidentConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <circle cx="8" cy="8" r="3.5" stroke={color} strokeWidth={strokeWidth} />
      <circle cx="8" cy="8" r="1.5" fill={color} />
    </svg>
  );
}

/** Point-on-line constraint (filled dot sitting on a line) */
export function PointOnLineConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line x1="2" y1="13" x2="14" y2="3" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <circle cx="8" cy="8" r="1.7" fill={color} />
    </svg>
  );
}

/** Point-on-circle constraint (filled dot on a circle's perimeter) */
export function PointOnCircleConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <circle cx="8" cy="8" r="5" stroke={color} strokeWidth={strokeWidth} />
      <circle cx="13" cy="8" r="1.7" fill={color} />
    </svg>
  );
}

/** Symmetric constraint (two dots mirrored about a dashed centerline) */
export function SymmetryConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* Symmetry axis */}
      <line x1="8" y1="2" x2="8" y2="14" stroke={color} strokeWidth={strokeWidth} strokeDasharray="2 1.5" strokeLinecap="round" />
      {/* Two mirrored points */}
      <circle cx="3.5" cy="8" r="1.5" fill={color} />
      <circle cx="12.5" cy="8" r="1.5" fill={color} />
      {/* Tick marks */}
      <line x1="5.5" y1="8" x2="6.6" y2="8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="9.4" y1="8" x2="10.5" y2="8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

/** Horizontal dimension (distance X) — two points with arrows along X axis */
export function DistanceXToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line x1="3" y1="4" x2="3" y2="12" stroke={color} strokeWidth={strokeWidth} />
      <line x1="13" y1="4" x2="13" y2="12" stroke={color} strokeWidth={strokeWidth} />
      <line x1="3" y1="8" x2="13" y2="8" stroke={color} strokeWidth={strokeWidth} />
      <path d="M5 6.5L3 8L5 9.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 6.5L13 8L11 9.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <text x="8" y="14" fontSize="5" fill={color} textAnchor="middle" fontFamily="ui-monospace,monospace">X</text>
    </svg>
  );
}

/** Vertical dimension (distance Y) — two points with arrows along Y axis */
export function DistanceYToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line x1="4" y1="3" x2="12" y2="3" stroke={color} strokeWidth={strokeWidth} />
      <line x1="4" y1="13" x2="12" y2="13" stroke={color} strokeWidth={strokeWidth} />
      <line x1="8" y1="3" x2="8" y2="13" stroke={color} strokeWidth={strokeWidth} />
      <path d="M6.5 5L8 3L9.5 5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 11L8 13L9.5 11" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <text x="14" y="9" fontSize="5" fill={color} textAnchor="middle" fontFamily="ui-monospace,monospace">Y</text>
    </svg>
  );
}

/** Fix/lock constraint (padlock) */
export function FixConstraintIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <rect x="3.5" y="7" width="9" height="7" rx="1" stroke={color} strokeWidth={strokeWidth} />
      <path d="M5.5 7V5C5.5 3 6.5 1.5 8 1.5C9.5 1.5 10.5 3 10.5 5V7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <circle cx="8" cy="10.5" r="1" fill={color} />
    </svg>
  );
}

/** Dimension / ruler tool */
export function DimensionToolIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      {/* Extension lines */}
      <line x1="3" y1="3" x2="3" y2="9" stroke={color} strokeWidth={strokeWidth} />
      <line x1="13" y1="3" x2="13" y2="9" stroke={color} strokeWidth={strokeWidth} />
      {/* Dimension line with arrows */}
      <line x1="3" y1="6" x2="13" y2="6" stroke={color} strokeWidth={strokeWidth} />
      <path d="M5 4.5L3 6L5 7.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 4.5L13 6L11 7.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      {/* Value label background */}
      <rect x="6.5" y="10" width="3" height="3.5" rx="0.4" stroke={color} strokeWidth={strokeWidth} fill="none" />
    </svg>
  );
}

/**
 * Construction-geometry indicator: single dashed line in the construction
 * style color (#964B00 brown). Used on the ribbon toggle button.
 */
export function ConstructionGeometryIcon({ size = defaults.size, color = '#964B00', strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <line
        x1="2" y1="8" x2="14" y2="8"
        stroke={color}
        strokeWidth={Math.max(strokeWidth * 1.5, 1.2)}
        strokeDasharray="2.5,1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Green checkmark - Finish Sketch */
export function FinishSketchIcon({ size = defaults.size, color = '#22c55e', strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M3 8.5L6.5 12L13 4" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- Feature Status Icons ----

/** Green checkmark for successful features */
export function FeatureSuccessIcon({ size = 12, color = '#22aa44', ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" {...rest}>
      <path d="M2.5 6.5L5 9L9.5 3.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Warning triangle for features with warnings */
export function FeatureWarningIcon({ size = 12, color = '#cc7700', ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" {...rest}>
      <path d="M6 1L11 10H1L6 1Z" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6 4.5V7" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="6" cy="8.5" r="0.6" fill={color} />
    </svg>
  );
}

/** Red X for failed features */
export function FeatureErrorIcon({ size = 12, color = '#cc2222', ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" {...rest}>
      <circle cx="6" cy="6" r="4.5" stroke={color} strokeWidth="1.2" />
      <path d="M4 4L8 8M8 4L4 8" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** Suppressed / disabled indicator */
export function FeatureSuppressedIcon({ size = 12, color = '#999', ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" {...rest}>
      <circle cx="6" cy="6" r="4.5" stroke={color} strokeWidth="1.2" />
      <path d="M3 6H9" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// ---- Timeline Navigation Icons (defined here for consistency, but also available from Lucide) ----

/** Rollback marker - vertical bar with left arrow */
export function RollbackIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M6 3V13" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M11 5L6 8L11 11" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

// ---- Primitives ----
// One glyph per solid, all drawn in the same isometric view so the five read
// as a set in the CREATE dropdown.

/** Isometric cube */
export function BoxIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M8 1.5L14 5V11L8 14.5L2 11V5Z" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
      <path d="M2 5L8 8.5L14 5M8 8.5V14.5" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
    </svg>
  );
}

/** Upright cylinder — ellipse cap over two sides */
export function CylinderIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <ellipse cx="8" cy="4" rx="5" ry="2.2" stroke={color} strokeWidth={strokeWidth} />
      <path d="M3 4V12M13 4V12" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <path d="M3 12A5 2.2 0 0 0 13 12" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

/** Sphere — outline with an equator ellipse for volume */
export function SphereIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <circle cx="8" cy="8" r="6" stroke={color} strokeWidth={strokeWidth} />
      <ellipse cx="8" cy="8" rx="6" ry="2.4" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  );
}

/** Pointed cone on an elliptical base */
export function ConeIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <path d="M8 2L13 12M8 2L3 12" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <ellipse cx="8" cy="12" rx="5" ry="2.2" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  );
}

/** Torus — outer ring with the inner hole */
export function TorusIcon({ size = defaults.size, color = defaults.color, strokeWidth = defaults.strokeWidth, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...rest}>
      <ellipse cx="8" cy="8" rx="6.2" ry="4" stroke={color} strokeWidth={strokeWidth} />
      <ellipse cx="8" cy="8" rx="2.4" ry="1.3" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  );
}

// ---- Feature Type to Icon Mapping ----

/**
 * Icon/colour key for a feature. Every type keys on itself except
 * `primitive`, which keys on its shape — five different solids under one
 * feature type would otherwise all show the same glyph in the tree and
 * timeline, which is the one place you look to tell them apart.
 */
export function featureIconType(feature: { type: string; inputs: Record<string, unknown> }): string {
  if (feature.type !== 'primitive') return feature.type;
  return (feature.inputs as { shape?: { kind?: string } }).shape?.kind ?? 'primitive';
}

/** Returns the appropriate icon component for a given feature type */
export function getFeatureIcon(featureType: string, size = 14): ReactElement {
  switch (featureType) {
    case 'sketch':
      return <SketchIcon size={size} />;
    case 'extrude':
      return <ExtrudeIcon size={size} />;
    case 'hole':
      return <HoleIcon size={size} />;
    case 'cut':
      return <CutIcon size={size} />;
    case 'fuse':
      return <FuseIcon size={size} />;
    case 'fillet':
      return <FilletIcon size={size} />;
    case 'chamfer':
      return <ChamferIcon size={size} />;
    case 'mirror':
      return <MirrorIcon size={size} />;
    case 'pattern':
    case 'linearPattern':
    case 'circularPattern':
      return <PatternIcon size={size} />;
    case 'shell':
      return <ShellIcon size={size} />;
    case 'revolve':
      return <RevolveIcon size={size} />;
    case 'constructionPlane':
      return <PlaneIcon size={size} />;
    case 'box':
    case 'primitive':
      return <BoxIcon size={size} />;
    case 'cylinder':
      return <CylinderIcon size={size} />;
    case 'sphere':
      return <SphereIcon size={size} />;
    case 'cone':
      return <ConeIcon size={size} />;
    case 'torus':
      return <TorusIcon size={size} />;
    case 'importedGeometry':
      return <ExtrudeIcon size={size} />;
    case 'componentInstance':
    case 'importedComponent':
      // Reuse ExtrudeIcon as a placeholder until a component-specific
      // glyph lands; pairs with the indigo color below for distinctness.
      return <ExtrudeIcon size={size} />;
    default:
      return <ExtrudeIcon size={size} />;
  }
}

/** Icon color mapping for feature types in tree/timeline */
export const featureTypeColors: Record<string, string> = {
  sketch: '#3b82f6',     // blue
  extrude: '#22c55e',    // green
  hole: '#f97316',       // orange
  cut: '#ef4444',        // red
  fuse: '#8b5cf6',       // purple
  fillet: '#06b6d4',     // cyan
  chamfer: '#06b6d4',    // cyan
  mirror: '#a855f7',     // violet
  pattern: '#eab308',    // yellow
  linearPattern: '#eab308',
  circularPattern: '#eab308',
  shell: '#64748b',      // slate
  revolve: '#ec4899',    // pink
  constructionPlane: '#3b82f6', // blue — same family as Sketch (both are reference-geometry inputs)
  componentInstance: '#6366f1',  // indigo
  importedComponent: '#6366f1',  // indigo — same family as componentInstance
  importedGeometry: '#64748b',   // slate
  // Primitives key on their shape (see `featureIconType`) and share one
  // teal, because they are one feature type doing one job.
  primitive: '#14b8a6',
  box: '#14b8a6',
  cylinder: '#14b8a6',
  sphere: '#14b8a6',
  cone: '#14b8a6',
  torus: '#14b8a6',
};
