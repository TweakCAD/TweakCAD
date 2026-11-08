/** The viewport's colours and sizes. */

/** A body's colour when no attribute sets one (16.1). */
export const DEFAULT_BODY_COLOR = '#6699cc';
export const EDGE_COLOR = 0x333333;
/** Edges of a body whose feature is selected. */
export const SELECTED_EDGE_COLOR = 0x1a6fd1;
/** A selected body glows in its own colour mixed halfway to white, at this intensity. */
export const HIGHLIGHT_GLOW = 0.35;
/** Opacity of bodies while a sketch is edited. */
export const GHOST_OPACITY = 0.25;

export interface HighlightStyle {
  faceColor: number;
  faceOpacity: number;
  lineColor: number;
  regionColor: number;
  regionOpacity: number;
  /** Opacity of a standard plane in this state. */
  planeOpacity: number;
}

export const SELECTION: HighlightStyle = {
  faceColor: 0xfacc15,
  faceOpacity: 0.35,
  lineColor: 0xeab308,
  regionColor: 0xfbbf24,
  regionOpacity: 0.35,
  planeOpacity: 0.45,
};

/** Hovered edges, curves and points are orange: they stand out on a picked (yellow) face and on a body. */
export const PRESELECTION: HighlightStyle = {
  faceColor: 0xfef08a,
  faceOpacity: 0.35,
  lineColor: 0xf97316,
  regionColor: 0x60a5fa,
  regionOpacity: 0.25,
  planeOpacity: 0.45,
};

export const SKETCH_LINE = 0x3b82f6;
export const SKETCH_CONSTRUCTION = 0x94a3b8;
export const SKETCH_REGION = 0x93c5fd;
export const SKETCH_REGION_OPACITY = 0.15;
/** Sketch curves sit this far above their plane, so a sketch on a face is not hidden by it. */
export const SKETCH_LIFT = 0.01;

export const CONSTRUCTION_FILL = 0x3b82f6;
export const CONSTRUCTION_OUTLINE = 0x1d4ed8;
export const CONSTRUCTION_PLANE_SIZE = 80;
export const CONSTRUCTION_OPACITY = 0.12;

export const STANDARD_PLANE_SIZE = 60;
export const STANDARD_PLANE_OPACITY = 0.15;

/** Pick tolerance for sketch curves, construction geometry and points, in screen pixels. */
export const PICK_PIXELS = 5;

/** Pick tolerance for body edges, in screen pixels: tighter, so a click inside a small face picks the face. */
export const EDGE_PICK_PIXELS = 3;

/** Width of a highlighted edge, sketch curve or construction outline, in screen pixels. */
export const HIGHLIGHT_EDGE_PIXELS = 2;

/** Render orders: translucent layers after solid bodies, highlights last. */
export const ORDER = {
  thread: 800,
  region: 900,
  highlight: 999,
  construction: 1450,
  standard: 1500,
} as const;
