/**
 * Editing one `core.sketch` feature through the editor: the tools, snapping,
 * selection, dragging, constraints and dimensions of the sketch editor.
 *
 * The session reads the sketch's rows from the editor's document and keeps a
 * working copy while a drag or a tool is in progress. Every change is solved
 * here with planegcs and written as one `editSketch` command carrying the
 * solved sketch, so region fates are written (8.3); undo and redo are the
 * editor's. A change the solver cannot meet is refused and changes nothing.
 */
import type { GcsWrapper } from '@salusoft89/planegcs';
import { detectRegions, type Detection } from '@tweakcad/format';
import {
  bindExpression,
  freeValueName,
  withDefaultUnit,
  type CommandResult,
  type Doc,
  type Editor,
  type EditorCommand,
} from '@tweakcad/editor';
import { Draft, type Change, type RowUpdate } from './change';
import {
  CONSTRAINT_PROMPTS,
  CURVE_CONSTRAINTS,
  constraintPickStep,
  constraintReason,
  fittingConstraints,
  offsetGroups,
  originPairs,
  planConstraint,
  sortSelection,
  type ConstraintKind,
} from './constraints';
import {
  formatNumber,
  labelAnchor,
  labelExpression,
  labelText,
  planDimension,
  valueText,
  type DimensionMode,
} from './dimensions';
import { SketchDrawing, type DrawingView, type PreviewShape } from './draw';
import { SketchGeometry, flagOn } from './geometry';
import type { SketchHost, SketchLabel, SketchPointer } from './host';
import {
  DIMENSION_KINDS,
  RowMaker,
  exprText,
  STANDARD_IDS,
  standardName,
  standardOf,
  curvePoints,
  namedIds,
  operandOf,
  pointOperand,
  curveOperand,
  sketchInputs,
  table,
  type Json,
  type P2,
  type StandardName,
} from './rows';
import { externalRows, type ExternalMode } from './externals';
import { readDrawing, type DrawingFormat } from './io/sketchFile';
import { glyphAnchors, type GlyphAnchor } from './glyphs';
import {
  offsetSide,
  planExtend,
  planFillet,
  planMirror,
  planOffsets,
  planTrim,
  type ModifyContext,
  type ModifyPlan,
  type OffsetDirection,
} from './modify';
import {
  SHAPES,
  SHAPE_TOOLS,
  circumcircle,
  leavingDirection,
  passesCounterClockwise,
  type ShapeContext,
  type ShapeTool,
} from './shapes';
import { interiorPoint, regionAt, regionId, regionIndex } from './regionPick';
import { inferAxis, snapAt, type Snap } from './snap';
import { externalShapes, solveInputs, solvedSketchOf, type ExternalShape } from './solve';
import {
  DEFAULT_SKETCH_FONT,
  SKETCH_FONTS,
  fontEntry,
  fontEntryIn,
  fontsIn,
  textFields,
  textGlyphs,
  textRow,
  type LoadedFont,
  type TextOptions,
} from './text';
import { WorkingValues } from './values';
import { dispatchSketchCommit, planSketchCommit } from './commit';
import { layoutText } from '@tweakcad/worker/src/v2/sketchText';
import { prepareCurve, type CurveShape, type SolvedCurve } from '@tweakcad/format';

export { circumcircle, passesCounterClockwise };

/** The modify tools: each picks curves and edits them. */
export type ModifyTool = 'trim' | 'extend' | 'fillet' | 'offset' | 'mirror';

/** Tools that pick model geometry: the shell turns the pick into external curves. */
export type ExternalTool = 'project' | 'intersect';

export type SketchTool =
  | 'select'
  | 'line'
  | 'rectangle'
  | 'circle'
  | 'arc'
  | 'point'
  | ShapeTool
  | 'text'
  | ModifyTool
  | ExternalTool
  | 'dimension'
  | 'dimensionX'
  | 'dimensionY'
  /** A constraint chosen before its geometry: the clicks pick what it holds. */
  | 'constrain';

export const SKETCH_TOOLS: readonly SketchTool[] = [
  'select',
  'line',
  'rectangle',
  'circle',
  'arc',
  'point',
  ...SHAPE_TOOLS,
  'text',
  'trim',
  'extend',
  'fillet',
  'offset',
  'mirror',
  'project',
  'intersect',
  'dimension',
  'dimensionX',
  'dimensionY',
  'constrain',
];

/** The viewport's cursor for a tool: a crosshair for every tool but Select. */
export function toolCursor(tool: SketchTool | null): string {
  return tool === null || tool === 'select' ? '' : 'crosshair';
}

const isShape = (t: SketchTool | null): t is ShapeTool => t !== null && (SHAPE_TOOLS as readonly string[]).includes(t);

/** What the palette shows of one selected line, circle, arc or point. */
export interface SelectedDetails {
  title: string;
  props: { label: string; value: string }[];
}

const coordinates = (p: P2) => `(${p[0].toFixed(1)}, ${p[1].toFixed(1)})`;
const millimetres = (v: number) => `${v.toFixed(2)} mm`;

/** The measures of a selected line (ends, length), circle (centre, radius, diameter), arc (centre, radius) or point (X, Y). */
export function selectedDetails(geometry: SketchGeometry, id: string): SelectedDetails | null {
  const at = geometry.points.get(id);
  const c = geometry.curves.get(id);
  const point = at ?? (c?.kind === 'point' ? geometry.points.get(c.row.at as string) : undefined);
  if (point)
    return {
      title: 'Point',
      props: [
        { label: 'X', value: millimetres(point[0]) },
        { label: 'Y', value: millimetres(point[1]) },
      ],
    };
  const shape = c?.shape;
  if (!c || !shape) return null;
  const construction = c.construction ? 'Construction ' : '';
  if (shape.kind === 'line') {
    return {
      title: `${construction}Line`,
      props: [
        { label: 'Start', value: coordinates(shape.start) },
        { label: 'End', value: coordinates(shape.end) },
        { label: 'Length', value: millimetres(near(shape.start, shape.end)) },
      ],
    };
  }
  const radius = geometry.radius(id);
  if (radius === undefined || (shape.kind !== 'circle' && shape.kind !== 'arc')) return null;
  const props = [
    { label: 'Center', value: coordinates(shape.center) },
    { label: 'Radius', value: millimetres(radius) },
  ];
  if (shape.kind === 'circle')
    return { title: `${construction}Circle`, props: [...props, { label: 'Diameter', value: millimetres(2 * radius) }] };
  return { title: 'Arc', props };
}

/** One row of the sketch browser. */
export interface BrowsedRow {
  id: string;
  kind: string;
  label: string;
  /** A measure or value beside the label. */
  sub: string;
  construction: boolean;
  /** For a constraint: whether it is active. */
  active?: boolean;
}

/** What the sketch browser calls each kind of row. */
const KIND_TITLES: Record<string, string> = {
  line: 'Line',
  circle: 'Circle',
  arc: 'Arc',
  ellipse: 'Ellipse',
  ellipticalArc: 'Elliptical arc',
  spline: 'Spline',
  bezier: 'Bezier',
  conic: 'Conic',
  nurbs: 'Spline',
  point: 'Point',
  external: 'Projected curve',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  collinear: 'Collinear',
  equal: 'Equal',
  tangent: 'Tangent',
  concentric: 'Concentric',
  coradial: 'Coradial',
  midpoint: 'Midpoint',
  symmetric: 'Symmetric',
  pointOnCurve: 'Point on curve',
  fixed: 'Fix',
  block: 'Block',
  offset: 'Offset',
  normal: 'Normal',
  curvature: 'Curvature',
  distance: 'Distance',
  distanceX: 'Horizontal distance',
  distanceY: 'Vertical distance',
  length: 'Length',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
};

/** What the sketch browser calls the sketch's own origin and axes. */
const STANDARD_TITLES: Record<StandardName, string> = { origin: 'origin', x: 'X axis', y: 'Y axis' };

/** The numbers the polygon, offset and fillet tools take, as their fields show them. */
export interface ToolSettings {
  sides: number;
  /** Offset distance, mm: the one side, both sides of Symmetric, or the first side of Two sides. */
  offset: number;
  /** The other side's offset distance with Two sides, mm. */
  offset2: number;
  offsetDirection: OffsetDirection;
  /** Fillet radius, mm. */
  fillet: number;
}

/** What the sketch shows and how it snaps; the palette's options. */
export interface SketchOptions {
  grid: boolean;
  /** Snap to the grid when nothing nearer snaps. */
  gridSnap: boolean;
  /** Closed regions shaded. */
  profile: boolean;
  points: boolean;
  dimensions: boolean;
  /** Constraint glyphs. */
  constraints: boolean;
  /** Construction curves. */
  construction: boolean;
}

export const GRID_SPACING = 10;

/** A snapshot of the session for the palette and labels; a new object after every change. */
export interface SketchSessionState {
  tool: SketchTool | null;
  /** The constraint the `constrain` tool applies. */
  constraint: ConstraintKind | null;
  /** Selected point, curve and constraint ids. */
  selection: readonly string[];
  hover: string | null;
  /** Whether new curves are construction curves. */
  construction: boolean;
  options: SketchOptions;
  /** Why the last change was refused, until the next change. */
  message: string | null;
  /** Degrees of freedom left, or null when the sketch does not solve. */
  dof: number | null;
  /** The dimension whose label is open for editing: one just placed, or one clicked. */
  editing: string | null;
  /** Which constraints the selection fits. */
  fits: Record<ConstraintKind, boolean>;
  counts: { points: number; curves: number; constraints: number };
  /** The selected curve, point or constraint's rows, for the palette's details. */
  selected: { id: string; kind: string; construction: boolean; constraints: { id: string; kind: string }[] }[];
  /** A single selected line, circle, arc or point's measures, for the palette. */
  details: SelectedDetails | null;
  /** False once the sketch feature is gone from the document (an undo removed it). */
  open: boolean;
  settings: ToolSettings;
  /** What the tool in progress asks for next. */
  prompt: string | null;
  /** The curve the Offset dialog offsets, until OK or Cancel. */
  offsetCurve: string | null;
  /** What the text tool writes, and the text row it is editing, if any. */
  text: TextOptions & {
    editing: string | null;
    /** The edited text's font when it is none the tool offers: kept until another is picked. */
    heldFont: string | null;
  };
}

export interface SketchSessionOptions {
  /** External curves as evaluation built them, so the solve can hold them. */
  externals?: readonly ExternalShape[];
}

/** What the session asks of the shell for tools that leave the sketch plane's rows. */
export interface SketchSessionEvents {
  /** The text tool clicked: where the text goes in the sketch. */
  text?: (at: P2) => void;
}

type ToolState =
  | { kind: 'idle' }
  /** A chain of lines; `press` while the button is held where the next segment starts, so a drag from there makes a tangent arc. */
  | { kind: 'line'; start: Snap; press?: P2 }
  /** A tangent arc dragged from the end of a line or arc with the line tool. */
  | { kind: 'lineArc'; start: Snap & { kind: 'point' } }
  | { kind: 'rectangle'; first: Snap }
  | { kind: 'circle'; center: Snap }
  | { kind: 'arc'; start: Snap; end?: Snap }
  | { kind: 'dimension'; first: string }
  | { kind: 'shape'; tool: ShapeTool; snaps: Snap[]; sweep: number; angle: number | null }
  | { kind: 'fillet'; first: string }
  /** The Offset dialog open on a curve, its copies previewed on `side` until OK. */
  | { kind: 'offset'; curve: string; side: 1 | -1 }
  | { kind: 'press'; target: string | null; at: P2; pixel: number; shift: boolean }
  | { kind: 'drag'; drag: Drag; at: P2; moved: boolean }
  | { kind: 'box'; from: P2; to: P2; shift: boolean };

type Drag =
  | { kind: 'points'; ids: string[]; start: Map<string, P2> }
  /** A circle or arc resized about its centre; an arc's ends keep their directions from it. */
  | { kind: 'radius'; curve: string; center: string; at: P2; ends: Map<string, P2> };

const LENGTH = { type: 'number', quantity: 'length' } as const;
const ANGLE = { type: 'number', quantity: 'angle' } as const;
/** Pixels a press moves before it is a drag. */
const DRAG_PIXELS = 3;
const POINT_PICK_PIXELS = 12;
const CURVE_PICK_PIXELS = 8;

const refusal = (
  message: string,
  code: 'not-allowed' | 'bad-argument' | 'not-found' = 'not-allowed',
): CommandResult => ({
  ok: false,
  error: { code, message },
});

const near = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The glyphs of a sketch without text: one array, so caches keyed on it hold. */
const NO_GLYPHS: SolvedCurve[] = [];

export class SketchSession {
  readonly host: SketchHost;
  private readonly editor: Editor;
  private readonly gcs: GcsWrapper;
  private externals: readonly ExternalShape[];
  /** The shell's handlers for the text tool. */
  events: SketchSessionEvents = {};
  private settings: ToolSettings = { sides: 6, offset: 5, offset2: 5, offsetDirection: 'one', fillet: 5 };
  private textOptions: TextOptions = { string: 'Text', font: DEFAULT_SKETCH_FONT, size: 10 };
  private textEditing: string | null = null;
  /** Whether a font was picked for the text being edited, so an edit writes it. */
  private fontChosen = false;
  /** The name of the edited text's font when it is none the tool offers. */
  private textHeldFont: string | null = null;
  /** The font the text tool writes in, once loaded. */
  private textFont: LoadedFont | null = null;
  /** Fonts the document holds, by library entry, read again when its library or assets change. */
  private fonts = new Map<string, ReturnType<typeof fontsIn> extends Map<string, infer F> ? F : never>();
  private fontsFrom: { library: unknown; assets: unknown } | null = null;
  /** Counts changes to `fonts`, so glyphs laid out before are laid out again. */
  private fontsVersion = 0;
  /** What the cached glyphs were laid out from. */
  private glyphsFor: { inputs: Json; values: WorkingValues; fonts: number } | null = null;
  private glyphCache: SolvedCurve[] | null = null;
  private readonly make: RowMaker;
  private readonly drawing: SketchDrawing;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;

  private doc: Doc;
  /** The sketch's rows as the document has them. */
  private stored: Json;
  /**
   * The stored rows as the document's values solve them now: a parameter
   * change moves them before any edit writes the new positions. The stored
   * rows when the sketch does not solve.
   */
  private base: Json;
  /** Degrees of freedom of `base`. */
  private baseDof: number | null = null;
  /** What is shown: `base`, or a drag's solved working copy. */
  private working: Json;
  private values: WorkingValues;
  private geometry: SketchGeometry;
  private detection: Detection | null = null;
  /** What the cached regions were detected from: the rows shown and everything their shapes depend on. */
  private detectedFor: {
    working: Json;
    values: WorkingValues;
    externals: readonly ExternalShape[];
    glyphs: SolvedCurve[] | null;
  } | null = null;

  private currentTool: SketchTool | null = 'select';
  private constraintKind: ConstraintKind | null = null;
  private toolState: ToolState = { kind: 'idle' };
  private selection: string[] = [];
  private hover: string | null = null;
  private cursor: P2 | null = null;
  private snap: Snap | null = null;
  private pixel = 0.1;
  private construction = false;
  private options: SketchOptions = {
    grid: true,
    gridSnap: false,
    profile: true,
    points: true,
    dimensions: true,
    constraints: true,
    construction: true,
  };
  private message: string | null = null;
  private dof: number | null = null;
  private editing: string | null = null;
  /** The last under-defined hint, for the rows and degrees of freedom it was written for. */
  private underDefined: { rows: Json; dof: number; text: string } | null = null;
  private open = true;
  /** Set by `dispose`. */
  private disposed = false;
  private state: SketchSessionState;
  /** Set while this session's own command runs, so its store notification is not taken for an outside change. */
  private committing = false;

  constructor(host: SketchHost, gcs: GcsWrapper, options: SketchSessionOptions = {}) {
    this.host = host;
    this.editor = host.editor;
    this.gcs = gcs;
    this.externals = options.externals ?? [];
    this.make = new RowMaker((kind) => this.editor.newId(kind));
    this.drawing = new SketchDrawing(host.group, host.frame);
    this.doc = this.editor.document;
    const inputs = sketchInputs(this.doc, host.part, host.feature);
    if (!inputs) throw new Error(`${host.feature} is not a sketch of ${host.part}`);
    this.stored = inputs;
    this.base = inputs;
    this.working = inputs;
    this.values = new WorkingValues(this.doc);
    this.geometry = this.geometryOf(inputs);
    this.state = this.snapshot();
    this.reload(true);
    this.unsubscribe = this.editor.store.subscribe(() => this.reload());
  }

  // ---- public API ----

  get tool(): SketchTool | null {
    return this.currentTool;
  }

  getState = (): SketchSessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setTool(name: SketchTool | null): void {
    this.restoreWorking();
    this.currentTool = name;
    this.constraintKind = null;
    this.toolState = { kind: 'idle' };
    this.snap = null;
    if (name !== 'select') this.hover = null;
    this.changed();
  }

  setSettings(settings: Partial<ToolSettings>): void {
    const next = { ...this.settings, ...settings };
    next.sides = Math.max(3, Math.min(64, Math.round(next.sides)));
    this.settings = next;
    this.changed();
  }

  setTextOptions(options: Partial<TextOptions>): void {
    // Picking a font for the text being edited changes its font once that font has loaded.
    const picked = options.font !== undefined && this.textEditing !== null;
    // The same font as the tool's is loaded already, so the panel loads nothing.
    const loaded = picked && options.font === this.textOptions.font ? this.textFont : null;
    if (picked) {
      this.fontChosen = true;
      this.textHeldFont = null;
    }
    this.textOptions = { ...this.textOptions, ...options };
    this.changed();
    if (loaded) this.setTextFont(loaded);
  }

  /** The font the text tool writes in, as the text panel loaded it; a font picked for the text being edited is written to it. */
  setTextFont(font: LoadedFont | null): void {
    this.textFont = font;
    this.changed();
    const id = this.textEditing;
    const row = id ? table(this.stored, 'text').find((t) => t.id === id) : undefined;
    const fields = row ? textFields(this.values, row) : null;
    if (font && this.fontChosen && fields && fontEntryIn(this.doc, font.hash) !== fields.library) this.updateText();
  }

  /** Writes the text options to the text row being edited, as one edit; its font only when one was picked for it. */
  updateText(): CommandResult {
    const id = this.textEditing;
    const row = id ? table(this.stored, 'text').find((t) => t.id === id) : undefined;
    if (!row || !id) return refusal('There is no text being edited', 'not-found');
    const font = this.fontChosen ? this.textFont : null;
    if (this.fontChosen && !font) return this.refuse('The font is still loading');
    const fields = textFields(this.values, row);
    if (!fields) return this.refuse('That text cannot be edited here');
    if (this.textOptions.string.trim() === '') return this.refuse('Type the text');
    if (!(this.textOptions.size > 0)) return this.refuse('A text height is more than 0 mm', 'bad-argument');
    const { library, before } = font ? this.fontLibrary(font) : { library: fields.library, before: [] };
    const value = (v: unknown, text: string) => ({ ...(v as Json), def: { expr: { text, grammar: 1, refs: {} } } });
    const set: Json = {
      string: value(row.string, JSON.stringify(this.textOptions.string)),
      size: value(row.size, `${this.textOptions.size} mm`),
    };
    if (library !== fields.library) {
      set.font = {
        ...(row.font as Json),
        def: { expr: { text: 'typeface', grammar: 1, refs: { typeface: { library: { id: library } } } } },
      };
    }
    return this.commit({ label: 'Edit text', update: [{ id, set }], ...(before.length > 0 ? { before } : {}) });
  }

  private stopEditingText(): void {
    this.textEditing = null;
    this.fontChosen = false;
    this.textHeldFont = null;
  }

  /** Starts editing a text row: the tool's options become its own, its font the bundled one of that name or else kept as it is. */
  private editText(id: string, fields: { string: string; size: number; library: string }): void {
    this.textEditing = id;
    this.fontChosen = false;
    const library = Array.isArray(this.doc.library) ? (this.doc.library as Json[]) : [];
    const name = library.find((e) => e.id === fields.library)?.name;
    const bundled = SKETCH_FONTS.find((f) => f.label === name);
    this.textHeldFont = bundled ? null : typeof name === 'string' ? name : 'Its own font';
    this.textOptions = {
      ...this.textOptions,
      string: fields.string,
      size: fields.size,
      ...(bundled ? { font: bundled.id } : {}),
    };
  }

  /** The library entry for a font: the document's own, or one the edit adds first. */
  private fontLibrary(font: LoadedFont): { library: string; before: EditorCommand[] } {
    const held = fontEntryIn(this.doc, font.hash);
    if (held) return { library: held, before: [] };
    const made = fontEntry(font, this.editor.newId('lib'));
    this.fonts.set(made.entry.id as string, font.font);
    this.fontsVersion++;
    return {
      library: made.entry.id as string,
      before: [{ type: 'addLibraryEntry', entry: made.entry, assets: made.assets }],
    };
  }

  /** Places text with the text tool's options, its baseline starting at `at`. */
  placeText(at: P2): CommandResult {
    const font = this.textFont;
    if (!font) return this.refuse('The font is still loading');
    if (this.textOptions.string.trim() === '') return this.refuse('Type the text');
    if (!(this.textOptions.size > 0)) return this.refuse('A text height is more than 0 mm', 'bad-argument');
    const { library, before } = this.fontLibrary(font);
    const row = textRow(this.make, { string: this.textOptions.string, library, size: this.textOptions.size, at });
    return this.commit({ label: 'Add text', add: { text: [row] }, ...(before.length > 0 ? { before } : {}) });
  }

  /** The glyph contours of the text rows shown, laid out with the fonts held; null when some cannot be. */
  private textCurves(inputs: Json = this.working, values = this.values): SolvedCurve[] | null {
    if (table(inputs, 'text').length === 0) return NO_GLYPHS;
    const held = this.glyphsFor;
    if (held && inputs === held.inputs && values === held.values && held.fonts === this.fontsVersion)
      return this.glyphCache;
    const out = textGlyphs(inputs, values, this.fonts);
    if (values === this.values) {
      this.glyphsFor = { inputs, values, fonts: this.fontsVersion };
      this.glyphCache = out;
    }
    return out;
  }

  /** Reads the document's fonts again when its library or assets changed. */
  private refreshFonts(): void {
    const from = { library: this.doc.library, assets: this.doc.assets };
    if (this.fontsFrom && this.fontsFrom.library === from.library && this.fontsFrom.assets === from.assets) return;
    this.fontsFrom = from;
    for (const [id, font] of fontsIn(this.doc)) this.fonts.set(id, font);
    this.fontsVersion++;
  }

  /** The text row whose glyphs lie under `uv`. */
  private pickText(uv: P2, pixel = this.pixel): string | null {
    let best: string | null = null;
    let bestDistance = CURVE_PICK_PIXELS * pixel;
    for (const g of this.textCurves() ?? []) {
      const curve = prepareCurve(g.shape, false);
      const hit = curve?.closest(uv as [number, number])[0];
      if (hit && hit.distance <= bestDistance && 'glyph' in g.key) {
        best = g.key.glyph.text;
        bestDistance = hit.distance;
      }
    }
    return best;
  }

  private textPointer(e: SketchPointer, uv: P2): boolean {
    const onText = this.pickText(uv);
    if (e.type === 'move') {
      this.snap = this.snapFor(uv);
      if (onText !== this.hover) {
        this.hover = onText;
        this.changed();
      } else this.rebuild();
      return true;
    }
    if (e.type === 'up') return true;
    if (onText) {
      // A click on text edits it: the tool's options become its own.
      const row = table(this.stored, 'text').find((t) => t.id === onText);
      const fields = row ? textFields(this.values, row) : null;
      if (fields) {
        this.editText(onText, fields);
        this.selection = [onText];
        this.changed();
      }
      return true;
    }
    this.stopEditingText();
    this.selection = [];
    this.placeText(this.snapFor(uv).at);
    return true;
  }

  /** The text the tool would place at the pointer, as outlines. */
  private textPreview(at: P2): PreviewShape[] {
    const font = this.textFont;
    if (!font || this.textEditing || this.textOptions.string.trim() === '' || !(this.textOptions.size > 0)) return [];
    try {
      return layoutText(font.font, 'preview', this.textOptions.string, this.textOptions.size, {
        origin: [at[0], at[1]],
        angle: 0,
      }).flatMap((g) => {
        const curve = prepareCurve(g.shape, false);
        return curve ? [{ kind: 'polyline' as const, points: curve.flatten(curve.tMin, curve.tMax, 2) }] : [];
      });
    } catch {
      return [];
    }
  }

  /**
   * The sketch's rows for the sketch browser: its curves and text, then its
   * constraints, in table order, each with a short description.
   */
  browse(): { geometry: BrowsedRow[]; constraints: BrowsedRow[] } {
    const counts = new Map<string, number>();
    const numbered = (kind: string) => {
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      return n;
    };
    const geometry: BrowsedRow[] = [];
    for (const c of this.geometry.curves.values()) {
      const kind = c.kind;
      let sub = '';
      const shape = c.shape;
      if (shape?.kind === 'line') sub = `${formatNumber(near(shape.start, shape.end))} mm`;
      else if (shape?.kind === 'circle' || shape?.kind === 'arc')
        sub = `R ${formatNumber(this.geometry.radius(c.id) ?? 0)} mm`;
      geometry.push({
        id: c.id,
        kind,
        label: `${KIND_TITLES[kind] ?? kind} ${numbered(kind)}`,
        sub,
        construction: c.construction,
      });
    }
    for (const t of table(this.stored, 'text')) {
      const fields = textFields(this.values, t);
      geometry.push({
        id: t.id as string,
        kind: 'text',
        label: `Text ${numbered('text')}`,
        sub: fields ? `"${fields.string}"` : '',
        construction: false,
      });
    }
    const names = new Map(geometry.map((r) => [r.id, r.label]));
    const operandName = (v: unknown): string | null => {
      const standard = standardOf(v);
      if (standard) return STANDARD_TITLES[standard];
      const o = operandOf(v);
      if (!o) return null;
      if (!o.point) return names.get(o.id) ?? '?';
      const curve = this.pointCurveOf(o.id);
      return (curve && names.get(curve)) ?? 'point';
    };
    // What a geometric constraint holds: its operands by name, or a fixed point's coordinates.
    const holds = (c: Json): string => {
      if (c.kind === 'fixed') {
        const p = this.geometry.operandPoint(c.point);
        return p ? `(${p[0].toFixed(1)}, ${p[1].toFixed(1)})` : '';
      }
      const of = c.of as Json | undefined;
      const points = of?.points as Json | undefined;
      const operands = [of, points?.a, points?.b, c.a, c.b, c.point, c.curve, c.axis];
      return operands.flatMap((v) => operandName(v) ?? []).join(' ↔ ');
    };
    const constraints: BrowsedRow[] = [];
    const linked = this.linked();
    for (const c of table(this.stored, 'constraints')) {
      // Rows standing as one constraint are one row: a point held on the origin, or one Offset.
      const link = linked.get(c.id as string);
      if (link && link.lead !== c.id) continue;
      if (link?.kind === 'coincident') {
        constraints.push({
          id: c.id as string,
          kind: 'coincident',
          label: 'Coincident',
          sub: holds(c),
          construction: false,
          active: true,
        });
        continue;
      }
      const kind = c.kind as string;
      const measured = DIMENSION_KINDS.has(kind) ? this.geometry.measure(c) : null;
      const sub = DIMENSION_KINDS.has(kind)
        ? labelText(c, measured)
        : kind === 'offset'
          ? (exprText(c.distance) ?? '')
          : holds(c);
      constraints.push({
        id: c.id as string,
        kind,
        label: KIND_TITLES[kind] ?? kind,
        sub,
        construction: false,
        active: flagOn(this.values, c.active),
      });
    }
    return { geometry, constraints };
  }

  /**
   * A console line for a sketch with degrees of freedom left: how many, and
   * the lines, circles and arcs no dimension sizes; null when the sketch is
   * fully defined or does not solve.
   */
  /** A point inside each selected closed region, in the sketch frame, so the regions can be found again in the evaluated sketch. */
  selectedRegionPoints(): P2[] {
    const detection = this.regions();
    if (!detection) return [];
    return this.selection.flatMap((id) => {
      const index = regionIndex(id);
      const p = index === null ? null : interiorPoint(detection, index);
      return p ? [p] : [];
    });
  }

  underDefinedHint(): string | null {
    if (this.dof === null || this.dof === 0) return null;
    const cached = this.underDefined;
    if (cached && cached.rows === this.stored && cached.dof === this.dof) return cached.text;
    const text = this.describeUnderDefined(this.dof);
    this.underDefined = { rows: this.stored, dof: this.dof, text };
    return text;
  }

  private describeUnderDefined(dof: number): string {
    const sized = new Set<string>();
    for (const c of table(this.stored, 'constraints')) {
      if (!flagOn(this.values, c.active)) continue;
      if (c.kind === 'length' || c.kind === 'radius' || c.kind === 'diameter') {
        const o = operandOf(c.curve);
        if (o) sized.add(o.id);
      } else if (c.kind === 'distance') {
        const [a, b] = [operandOf(c.a), operandOf(c.b)];
        if (!a?.point || !b?.point) continue;
        const ends = new Set([a.id, b.id]);
        for (const curve of this.geometry.curves.values()) {
          if (curve.kind === 'line' && ends.has(curve.row.start as string) && ends.has(curve.row.end as string))
            sized.add(curve.id);
        }
      }
    }
    const open = this.browse().geometry.filter(
      (r) => (r.kind === 'line' || r.kind === 'circle' || r.kind === 'arc') && !sized.has(r.id),
    );
    const hint =
      open.length > 0
        ? ` Undimensioned: ${open.map((r) => r.label).join(', ')}.`
        : ' Add dimensions or pin points to the origin.';
    return `Sketch under-constrained: ${dof} DOF remaining.${hint}`;
  }

  /** Shows a row as hovered, as the sketch browser does under the pointer. */
  highlight(id: string | null): void {
    if (id === this.hover) return;
    this.hover = id;
    this.changed();
  }

  /** The geometry shown now, for exporting the sketch. */
  get shown(): SketchGeometry {
    return this.geometry;
  }

  /** The external curves' shapes as evaluation built them, when a new evaluation shows the sketch. */
  setExternals(given: readonly ExternalShape[]): void {
    // Curves added since keep the shapes they were added with until an evaluation builds them.
    const ids = new Set(given.map((e) => e.id));
    const live = new Set(table(this.stored, 'curves').map((c) => c.id as string));
    const externals = [...given, ...this.externals.filter((e) => !ids.has(e.id) && live.has(e.id))];
    const same =
      externals.length === this.externals.length &&
      externals.every((e, i) => JSON.stringify(e) === JSON.stringify(this.externals[i]));
    if (same) return;
    this.externals = externals;
    this.reload(true);
  }

  /** Shows why something the shell tried for the session's tool did not happen. */
  refuseWith(message: string): void {
    this.refuse(message);
  }

  /** Adds rows made elsewhere as one edit. */
  insert(change: Change): CommandResult {
    return this.commit(change);
  }

  /** Inserts a DXF or SVG drawing's curves into the sketch, at their own coordinates, as one edit. */
  insertDrawing(text: string, format: DrawingFormat): CommandResult {
    const read = readDrawing(text, format, this.make);
    if (!read.ok) return this.refuse(read.message);
    return this.commit(read.drawing.change);
  }

  /**
   * Adds the external curves a pick of model geometry yields: the reference
   * and the names it brings, and the curves as the service built them in
   * this sketch's frame, which the solve holds until evaluation builds them.
   */
  addExternal(
    picked: { reference: Json; names: Json },
    mode: ExternalMode,
    shapes: readonly CurveShape[],
  ): CommandResult {
    if (shapes.length === 0)
      return this.refuse(
        mode === 'project' ? 'That edge has nothing to project' : 'The sketch plane does not cut that',
      );
    const { rows, shapes: built } = externalRows(this.make, picked.reference, mode, shapes);
    const before = this.externals;
    this.externals = [...this.externals, ...built];
    const result = this.commit({
      label: mode === 'project' ? 'Project' : 'Intersect',
      add: { curves: rows },
      names: picked.names,
    });
    if (!result.ok) this.externals = before;
    return result;
  }

  setOptions(options: Partial<SketchOptions>): void {
    this.options = { ...this.options, ...options };
    this.changed();
  }

  setConstructionMode(on: boolean): void {
    this.construction = on;
    this.changed();
  }

  select(ids: readonly string[], add = false): void {
    const next = add ? [...this.selection] : [];
    for (const id of ids) {
      const at = next.indexOf(id);
      if (add && at >= 0) next.splice(at, 1);
      else if (at < 0) next.push(id);
    }
    this.selection = next.filter((id) => this.exists(id));
    this.changed();
  }

  clearSelection(): void {
    this.select([]);
  }

  /** Opens a dimension's label for editing. */
  editDimension(id: string): void {
    if (this.editing === id) return;
    this.editing = id;
    this.changed();
  }

  /** Closes the label open for editing. */
  clearEditing(): void {
    if (this.editing === null) return;
    this.editing = null;
    this.changed();
  }

  /** Handles a pointer event on the sketch plane; true when the session used it. */
  pointer(e: SketchPointer): boolean {
    if (!this.open || this.currentTool === null) return false;
    if (e.pixel > 0) this.pixel = e.pixel;
    const uv: P2 = e.uv;
    this.cursor = uv;
    if (e.type !== 'move' && e.button !== 0) return false;
    switch (this.currentTool) {
      case 'select':
        return this.selectPointer(e, uv);
      case 'dimension':
      case 'dimensionX':
      case 'dimensionY':
        return this.dimensionPointer(e, uv);
      case 'trim':
      case 'extend':
      case 'offset':
      case 'fillet':
      case 'mirror':
        return this.modifyPointer(e, uv);
      case 'project':
      case 'intersect':
        // Model geometry is the shell's to pick.
        return false;
      case 'text':
        return this.textPointer(e, uv);
      case 'constrain':
        return this.constrainPointer(e, uv);
      default:
        return isShape(this.currentTool) ? this.shapePointer(e, uv) : this.drawPointer(e, uv);
    }
  }

  /** Handles a key; true when the session used it. */
  key(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    // Keys typed into a field (the text tool's font list too) are the field's.
    const target = e.target as { tagName?: string; isContentEditable?: boolean } | null;
    const tag = target?.tagName?.toUpperCase();
    if (target && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    switch (e.key) {
      case 'Escape':
        // The spline's first Escape keeps the points placed so far.
        if (this.toolState.kind === 'shape' && this.toolState.tool === 'spline' && this.toolState.snaps.length >= 2)
          return this.finishShape();
        return this.escape();
      case 'Enter':
        if (this.toolState.kind === 'shape' && this.toolState.tool === 'spline') return this.finishShape();
        if (this.toolState.kind === 'offset') {
          this.confirmOffset();
          return true;
        }
        return false;
      case 'Delete':
      case 'Backspace':
        if (this.selection.length === 0) return false;
        this.deleteSelection();
        return true;
    }
    const shortcuts: Record<string, () => void> = {
      l: () => this.setTool('line'),
      r: () => this.setTool('rectangle'),
      c: () => this.setTool('circle'),
      a: () => this.setTool('arc'),
      p: () => this.setTool('project'),
      d: () => this.setTool('dimension'),
      t: () => this.setTool('trim'),
      o: () => this.setTool('offset'),
      x: () => this.toggleConstruction(),
    };
    // Shift+letter picks the same tool; a held key does not repeat it.
    const run = shortcuts[e.key.toLowerCase()];
    if (!run || e.repeat) return false;
    run();
    return true;
  }

  /**
   * The labels of the sketch's dimensions, anchored in part coordinates, and
   * of each offset's distance where it is named (the first copy of a chain).
   */
  labels(): SketchLabel[] {
    if (!this.options.dimensions) return [];
    const out: SketchLabel[] = [];
    for (const row of table(this.working, 'constraints')) {
      if (!flagOn(this.values, row.active)) continue;
      if (row.kind === 'offset') {
        const distance = row.distance as Json;
        const middle = operandOf(row.b) ? this.geometry.middleOf((operandOf(row.b) as { id: string }).id) : undefined;
        if (typeof distance.name !== 'string' || !middle) continue;
        let n: number | null;
        try {
          n = this.values.number(distance, LENGTH);
        } catch {
          n = null;
        }
        const shown = { kind: 'distance', value: distance, solved: n ?? 0 };
        out.push({
          id: row.id as string,
          at: this.toPart(middle),
          text: labelText(shown, n),
          expression: labelExpression(shown, n),
          unit: 'mm',
        });
        continue;
      }
      if (!DIMENSION_KINDS.has(row.kind as string)) continue;
      const anchor = labelAnchor(this.geometry, row);
      if (!anchor) continue;
      const measured = this.geometry.measure(row);
      out.push({
        id: row.id as string,
        at: this.toPart(anchor),
        text: labelText(row, measured),
        expression: labelExpression(row, measured),
        unit: row.kind === 'angle' ? 'deg' : 'mm',
      });
    }
    return out;
  }

  /** The glyphs of the active geometric constraints, anchored in part coordinates. */
  glyphs(): (GlyphAnchor & { part: [number, number, number] })[] {
    if (!this.options.constraints || !this.open) return [];
    return glyphAnchors(this.geometry, this.glyphRows()).map((g) => ({ ...g, part: this.toPart(g.at) }));
  }

  /** Writes a dimension's value (or an offset's distance) from expression text, solves and commits; refused, nothing changes. */
  setDimension(id: string, expression: string): CommandResult {
    const row = table(this.stored, 'constraints').find((c) => c.id === id);
    if (!row || !(DIMENSION_KINDS.has(row.kind as string) || row.kind === 'offset'))
      return refusal(`There is no dimension ${id} in this sketch`, 'not-found');
    if (row.kind === 'offset') return this.setOffsetDistance(row, expression);
    const value = row.value as Json;
    const angle = row.kind === 'angle';
    const text = withDefaultUnit(expression, angle ? 'deg' : 'mm');
    const bound = bindExpression(
      this.doc,
      { part: this.host.part, feature: this.host.feature, self: value.id as string },
      text,
      angle ? ANGLE : LENGTH,
    );
    if (!bound.ok) return this.refuse(bound.message, 'bad-argument');
    const signed = row.kind === 'distanceX' || row.kind === 'distanceY' || angle;
    // A value read from a measure has no stored number here; the solve decides it.
    if (!signed && typeof bound.stored === 'number' && !(bound.stored > 0))
      return this.refuse('A length is more than 0 mm', 'bad-argument');
    const next = { ...value, def: bound.def };
    return this.commit({
      label: 'Edit dimension',
      update: [{ id, set: { value: next } }],
      overrides: new Map([[value.id as string, bound.def]]),
    });
  }

  private setOffsetDistance(row: Json, expression: string): CommandResult {
    const value = row.distance as Json;
    const bound = bindExpression(
      this.doc,
      { part: this.host.part, feature: this.host.feature, self: value.id as string },
      withDefaultUnit(expression, 'mm'),
      LENGTH,
    );
    if (!bound.ok) return this.refuse(bound.message, 'bad-argument');
    if (typeof bound.stored === 'number' && !(bound.stored > 0))
      return this.refuse('An offset distance is more than 0 mm', 'bad-argument');
    return this.commit({
      label: 'Edit offset',
      update: [{ id: row.id as string, set: { distance: { ...value, def: bound.def } } }],
      overrides: new Map([[value.id as string, bound.def]]),
    });
  }

  /**
   * A constraint button: a selection the constraint fits takes it at once;
   * otherwise the constraint's tool starts, keeping a selection that can
   * still grow into what it takes, and each click then picks geometry until
   * the picks fit, when the constraint is applied and the tool waits for the
   * next picks.
   */
  constrain(kind: ConstraintKind): CommandResult | null {
    const picked = sortSelection(this.geometry, this.selection);
    if (this.selection.length > 0 && fittingConstraints(picked)[kind]) return this.applyConstraint(kind);
    const keep =
      this.selection.length > 0 && constraintPickStep(kind, picked, this.selection.length) === 'more'
        ? [...this.selection]
        : [];
    this.setTool('constrain');
    this.constraintKind = kind;
    this.selection = keep;
    this.message = null;
    this.changed();
    return null;
  }

  /** Applies a constraint to the selection. */
  applyConstraint(kind: ConstraintKind): CommandResult {
    const plan = planConstraint(kind, this.selection, {
      inputs: this.stored,
      geometry: this.geometry,
      make: this.make,
      active: (c) => flagOn(this.values, c.active),
    });
    if (!plan.ok) return this.refuse(plan.message);
    return this.commit(plan.change);
  }

  /** Makes the selected curves construction curves, or normal when all are; with no curves selected, switches the mode for new curves. */
  toggleConstruction(): CommandResult | null {
    const curves = this.selection.filter((id) => this.geometry.curves.has(id));
    if (curves.length === 0) {
      this.setConstructionMode(!this.construction);
      return null;
    }
    const on = !curves.every((id) => this.geometry.curves.get(id)?.construction);
    return this.setConstruction(curves, on);
  }

  setConstruction(curves: readonly string[], on: boolean): CommandResult {
    const update: RowUpdate[] = [];
    for (const id of curves) {
      const c = this.geometry.curves.get(id);
      if (!c || c.construction === on) continue;
      const flag = c.row.construction as Json;
      update.push({
        id,
        set: { construction: { ...flag, def: { expr: { text: on ? 'true' : 'false', grammar: 1, refs: {} } } } },
      });
    }
    if (update.length === 0) return { ok: true, label: 'Construction', changed: false };
    return this.commit({ label: on ? 'Make construction' : 'Make normal', update });
  }

  /** Deletes the selected curves, points and constraints; a point goes with the curves that use it. */
  deleteSelection(): CommandResult {
    const result = this.deleteRows(this.selection);
    if (result.ok) this.clearSelection();
    return result;
  }

  /**
   * Constraint rows that stand as one constraint: the horizontal and vertical
   * holding a point on the origin (a Coincident led by the horizontal), and
   * the rows of one Offset (led by its first copy). Each row's id to its
   * group.
   */
  private linked(): Map<string, { lead: string; ids: string[]; kind: 'coincident' | 'offset' }> {
    const rows = table(this.stored, 'constraints');
    const out = new Map<string, { lead: string; ids: string[]; kind: 'coincident' | 'offset' }>();
    for (const [id, partner] of originPairs(rows, (c) => flagOn(this.values, c.active))) {
      const lead = rows.find((c) => c.id === id)?.kind === 'horizontal' ? id : partner;
      out.set(id, { lead, ids: [id, partner], kind: 'coincident' });
    }
    for (const [lead, ids] of offsetGroups(rows))
      if (ids.length > 1) for (const id of ids) out.set(id, { lead, ids, kind: 'offset' });
    return out;
  }

  /** Constraint ids with the rest of each group they stand in, so a group goes as one. */
  private withPartners(ids: readonly string[]): string[] {
    const linked = this.linked();
    return [...new Set(ids.flatMap((id) => linked.get(id)?.ids ?? [id]))];
  }

  /** Deletes curves, points, text and constraints by id; a point goes with the curves that use it. */
  deleteRows(given: readonly string[]): CommandResult {
    const ids = this.withPartners(given);
    const remove = new Set<string>();
    const isRow = (id: string) =>
      this.geometry.curves.has(id) ||
      table(this.stored, 'constraints').some((c) => c.id === id) ||
      table(this.stored, 'text').some((t) => t.id === id);
    for (const id of ids) {
      if (isRow(id)) remove.add(id);
      else if (this.geometry.points.has(id)) {
        const users = table(this.stored, 'curves').filter((c) => curvePoints(c).includes(id));
        if (users.length === 0) remove.add(id);
        for (const c of users) remove.add(c.id as string);
      }
    }
    if (remove.size === 0) return { ok: true, label: 'Delete', changed: false };
    return this.commit({ label: 'Delete', remove: [...remove] });
  }

  /** Removes constraints by id. */
  removeConstraints(ids: readonly string[]): CommandResult {
    return this.commit({ label: 'Delete constraint', remove: this.withPartners(ids) });
  }

  /** Ends editing: drops what a tool had in progress. The shell then disposes the session. */
  finish(): void {
    this.restoreWorking();
    this.toolState = { kind: 'idle' };
    this.selection = [];
    this.hover = null;
    this.snap = null;
    this.currentTool = null;
    this.changed();
  }

  /** Closes the session for good: it draws nothing more, and every edit through it is refused. */
  dispose(): void {
    this.disposed = true;
    this.open = false;
    this.unsubscribe();
    this.listeners.clear();
    this.drawing.dispose();
    this.host.requestRender();
  }

  // ---- reading the document ----

  private reload(force = false): void {
    if (this.disposed) return;
    const doc = this.editor.document;
    if (!force && doc === this.doc) return;
    this.doc = doc;
    const inputs = sketchInputs(doc, this.host.part, this.host.feature);
    if (!inputs) {
      this.open = false;
      this.currentTool = null;
      this.toolState = { kind: 'idle' };
      this.selection = [];
      this.editing = null;
      this.drawing.clear();
      this.changed();
      return;
    }
    this.open = true;
    this.stored = inputs;
    this.values = new WorkingValues(doc);
    this.refreshFonts();
    if (this.textEditing && !table(inputs, 'text').some((t) => t.id === this.textEditing)) this.stopEditingText();
    if (!this.committing && (this.toolState.kind === 'drag' || this.toolState.kind === 'press'))
      this.toolState = { kind: 'idle' };
    const solved = solveInputs(this.gcs, this.values, inputs, this.externals);
    this.base = solved.ok ? solved.inputs : inputs;
    this.working = this.base;
    this.geometry = this.geometryOf(this.base);
    // A tool's pending point may be gone after an undo.
    const pending = this.pendingPoints();
    if (pending.some((id) => !this.geometry.points.has(id))) this.toolState = { kind: 'idle' };
    // Regions are detected again from the new rows, so a picked region is dropped.
    this.selection = this.selection.filter((id) => regionIndex(id) === null && this.exists(id));
    if (this.hover && (regionIndex(this.hover) !== null || !this.exists(this.hover))) this.hover = null;
    if (this.editing && !this.exists(this.editing)) this.editing = null;
    this.dof = solved.ok ? this.liveDof(solved.dof) : null;
    this.baseDof = this.dof;
    // An outside change (undo, redo, another panel) replaces the last refusal; a sketch that no longer solves says why.
    if (!this.committing) this.message = solved.ok ? null : solved.message;
    this.changed();
  }

  private pendingPoints(): string[] {
    const s = this.toolState;
    const of = (snap: Snap | undefined) => (snap?.kind === 'point' ? [snap.id] : []);
    if (s.kind === 'line' || s.kind === 'lineArc') return of(s.start);
    if (s.kind === 'rectangle') return of(s.first);
    if (s.kind === 'circle') return of(s.center);
    if (s.kind === 'arc') return [...of(s.start), ...of(s.end)];
    if (s.kind === 'shape') return s.snaps.flatMap(of);
    if (s.kind === 'fillet') return this.exists(s.first) ? [] : [s.first];
    if (s.kind === 'dimension') return this.exists(s.first) ? [] : [s.first];
    if (s.kind === 'offset') return this.exists(s.curve) ? [] : [s.curve];
    return [];
  }

  private exists(id: string): boolean {
    if (standardName(id)) return true;
    const region = regionIndex(id);
    if (region !== null) return region < (this.regions()?.regions.length ?? 0);
    return (
      this.geometry.points.has(id) ||
      this.geometry.curves.has(id) ||
      table(this.stored, 'constraints').some((c) => c.id === id) ||
      table(this.stored, 'text').some((t) => t.id === id)
    );
  }

  private geometryOf(inputs: Json): SketchGeometry {
    return new SketchGeometry(inputs, this.values, externalShapes(this.externals));
  }

  /**
   * The solver's degrees of freedom without the points nothing uses: the
   * ends a trim leaves for retired rows are free in the solve but not shown.
   */
  private liveDof(dof: number): number {
    const named = new Set<string>();
    for (const c of table(this.stored, 'constraints')) for (const id of namedIds(c)) named.add(id);
    let unused = 0;
    for (const id of this.geometry.points.keys()) if (!this.geometry.used.has(id) && !named.has(id)) unused++;
    return Math.max(0, dof - 2 * unused);
  }

  // ---- committing ----

  private refuse(message: string, code: 'not-allowed' | 'bad-argument' = 'not-allowed'): CommandResult {
    this.message = message;
    this.changed();
    return refusal(message, code);
  }

  /**
   * Solves the sketch as `change` leaves it and writes it as one command.
   * New constraints the solver finds conflicting or redundant refuse the
   * change; optional ones (from snaps and inference) are left out instead.
   */
  private commit(change: Change): CommandResult {
    if (this.disposed) return refusal('The sketch is no longer being edited');
    const plan = planSketchCommit(
      {
        doc: this.doc,
        gcs: this.gcs,
        feature: this.host.feature,
        stored: this.stored,
        externals: this.externals,
        glyphs: (inputs, values) => this.textCurves(inputs, values),
      },
      change,
    );
    if (!plan.ok) return this.refuse(plan.message, plan.code);
    this.committing = true;
    let result: CommandResult;
    try {
      result = dispatchSketchCommit(this.editor, plan);
    } finally {
      this.committing = false;
    }
    if (!result.ok) return this.refuse(result.error.message);
    this.message = null;
    this.changed();
    return result;
  }

  // ---- picking ----

  /**
   * The point or curve under `uv`: points first, then the nearest curve.
   * With `standard`, the sketch origin after the points and its axes after
   * the curves, for constraints and dimensions against them.
   */
  private pick(
    uv: P2,
    pixel = this.pixel,
    exclude?: ReadonlySet<string>,
    standard: boolean | 'origin' = false,
  ): string | null {
    let best: string | null = null;
    let bestDistance = POINT_PICK_PIXELS * pixel;
    for (const [id, p] of this.geometry.points) {
      if (exclude?.has(id) || !this.pointShown(id)) continue;
      const d = near(p, uv);
      if (d <= bestDistance) {
        best = id;
        bestDistance = d;
      }
    }
    if (best) return this.pointCurveOf(best) ?? best;
    if (standard && near(uv, [0, 0]) <= bestDistance) return STANDARD_IDS.origin;
    bestDistance = CURVE_PICK_PIXELS * pixel;
    for (const c of this.geometry.curves.values()) {
      if (c.kind === 'point' || (c.construction && !this.options.construction)) continue;
      const d = this.geometry.distanceToCurve(c.id, uv);
      if (d <= bestDistance) {
        best = c.id;
        bestDistance = d;
      }
    }
    if (best || standard !== true) return best;
    const [dx, dy] = [Math.abs(uv[1]), Math.abs(uv[0])];
    if (dx <= bestDistance && dx <= dy) return STANDARD_IDS.x;
    if (dy <= bestDistance) return STANDARD_IDS.y;
    return null;
  }

  /** The point curve standing on a point, which is what picking the point selects. */
  private pointCurveOf(point: string): string | undefined {
    return [...this.geometry.curves.values()].find((c) => c.kind === 'point' && c.row.at === point)?.id;
  }

  private pointShown(id: string): boolean {
    if (!this.geometry.used.has(id)) return false;
    if (this.options.points) return true;
    return this.pointCurveOf(id) !== undefined;
  }

  private snapFor(uv: P2, exclude?: ReadonlySet<string>): Snap {
    return snapAt(this.geometry, uv, {
      pixel: this.pixel,
      ...(exclude ? { exclude } : {}),
      grid: this.options.gridSnap ? GRID_SPACING : null,
    });
  }

  // ---- the select tool ----

  private selectPointer(e: SketchPointer, uv: P2): boolean {
    const s = this.toolState;
    if (e.type === 'down') {
      this.toolState = { kind: 'press', target: this.pickOrRegion(uv), at: uv, pixel: this.pixel, shift: e.shift };
      return true;
    }
    if (e.type === 'move') {
      if (s.kind === 'press') {
        if (near(uv, s.at) < DRAG_PIXELS * s.pixel) return true;
        if (s.target === null || standardName(s.target) || regionIndex(s.target) !== null) {
          this.toolState = { kind: 'box', from: s.at, to: uv, shift: s.shift };
        } else {
          const drag = this.startDrag(s.target);
          if (!this.selection.includes(s.target)) this.select([s.target], s.shift);
          if (!drag) {
            this.toolState = { kind: 'idle' };
            return true;
          }
          this.toolState = { kind: 'drag', drag, at: s.at, moved: false };
          this.dragTo(uv);
        }
        this.rebuild();
        return true;
      }
      if (s.kind === 'drag') {
        this.dragTo(uv);
        return true;
      }
      if (s.kind === 'box') {
        this.toolState = { ...s, to: uv };
        this.rebuild();
        return true;
      }
      const hover = this.pickOrRegion(uv);
      if (hover !== this.hover) {
        this.hover = hover;
        this.changed();
      }
      return hover !== null;
    }
    // up
    this.toolState = { kind: 'idle' };
    if (s.kind === 'press') {
      if (s.target) this.select([s.target], s.shift);
      else if (!s.shift) this.clearSelection();
    } else if (s.kind === 'box') {
      this.select(this.boxed(s.from, s.to), s.shift);
    } else if (s.kind === 'drag') {
      this.endDrag(s.moved);
    }
    this.rebuild();
    return true;
  }

  /** The point or curve under `uv` (the sketch origin and axes too), else the smallest closed region holding it. */
  private pickOrRegion(uv: P2): string | null {
    const picked = this.pick(uv, this.pixel, undefined, true);
    if (picked) return picked;
    const detection = this.regions();
    const index = detection ? regionAt(detection, uv) : null;
    return index === null ? null : regionId(index);
  }

  /** Entities in a box: wholly inside when dragged left to right, touching when right to left. */
  private boxed(from: P2, to: P2): string[] {
    const [x0, x1] = [Math.min(from[0], to[0]), Math.max(from[0], to[0])];
    const [y0, y1] = [Math.min(from[1], to[1]), Math.max(from[1], to[1])];
    const inside = (p: P2) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
    const window = to[0] >= from[0];
    const out: string[] = [];
    for (const c of this.geometry.curves.values()) {
      if (c.kind === 'point') continue;
      const poly = c.polyline;
      if (poly.length === 0) continue;
      const hit = window
        ? poly.every(inside)
        : poly.some(inside) || poly.some((p, i) => i > 0 && segmentCrossesBox(poly[i - 1] as P2, p, x0, y0, x1, y1));
      if (hit) out.push(c.id);
    }
    for (const [id, p] of this.geometry.points)
      if (inside(p) && this.pointShown(id)) out.push(this.pointCurveOf(id) ?? id);
    return out;
  }

  private startDrag(target: string): Drag | null {
    const held = this.heldPoints();
    const c = this.geometry.curves.get(target);
    if ((c?.kind === 'circle' || c?.kind === 'arc') && !this.sizeHeld(target)) {
      const center = c.row.center as string;
      const at = this.geometry.point(center);
      if (at) {
        const ends = c.kind === 'arc' ? [c.row.start as string, c.row.end as string] : [];
        return {
          kind: 'radius',
          curve: target,
          center,
          at,
          ends: new Map(ends.map((id) => [id, this.geometry.point(id) as P2])),
        };
      }
    }
    const ids = (c ? curvePoints(c.row) : [target]).filter((id) => !held.has(id));
    if (ids.length === 0) return null;
    return { kind: 'points', ids, start: new Map(ids.map((id) => [id, this.geometry.point(id) as P2])) };
  }

  /** Points held where they are: fixed points and the points of blocked curves. */
  private heldPoints(): Set<string> {
    const held = new Set<string>();
    for (const c of table(this.stored, 'constraints')) {
      if (!flagOn(this.values, c.active)) continue;
      if (c.kind === 'fixed') {
        const o = operandOf(c.point);
        if (o) held.add(o.id);
      } else if (c.kind === 'block') {
        const o = operandOf(c.curve);
        const row = o ? this.geometry.curves.get(o.id)?.row : undefined;
        if (row) for (const p of curvePoints(row)) held.add(p);
      }
    }
    return held;
  }

  /** Whether a dimension or block already sets a circle's size, so a drag cannot. */
  private sizeHeld(curve: string): boolean {
    return table(this.stored, 'constraints').some(
      (c) =>
        (c.kind === 'radius' || c.kind === 'diameter' || c.kind === 'block') &&
        operandOf(c.curve)?.id === curve &&
        flagOn(this.values, c.active),
    );
  }

  /**
   * Moves the dragged points to follow the pointer and solves the working
   * copy, the dragged points held at the pointer. Where that cannot solve,
   * the solver is given the pointer position only as a start; where that
   * cannot either, the last solved frame stays.
   */
  private dragTo(uv: P2): void {
    const s = this.toolState;
    if (s.kind !== 'drag') return;
    const flag = { id: 'val_drag', def: { expr: { text: 'true', grammar: 1, refs: {} } } };
    let moved: Json;
    const holds: Json[] = [];
    if (s.drag.kind === 'points') {
      const single = s.drag.ids.length === 1;
      const target = single ? this.snapFor(uv, new Set(s.drag.ids)).at : uv;
      const delta: P2 = single ? [0, 0] : [uv[0] - s.at[0], uv[1] - s.at[1]];
      const to = new Map<string, P2>();
      for (const [id, p] of s.drag.start) to.set(id, single ? target : [p[0] + delta[0], p[1] + delta[1]]);
      moved = {
        ...this.base,
        points: table(this.base, 'points').map((p) => {
          const at = to.get(p.id as string);
          return at ? { ...p, x: at[0], y: at[1] } : p;
        }),
      };
      s.drag.ids.forEach((id, n) =>
        holds.push({ id: `con_drag${n}`, kind: 'fixed', active: flag, point: pointOperand(id) }),
      );
    } else {
      const center = s.drag.at;
      const radius = Math.max(0.01, near(uv, center));
      const curve = s.drag.curve;
      const ends = new Map<string, P2>();
      for (const [id, p] of s.drag.ends) {
        const d = near(p, center);
        if (d > 0)
          ends.set(id, [center[0] + ((p[0] - center[0]) * radius) / d, center[1] + ((p[1] - center[1]) * radius) / d]);
      }
      moved = {
        ...this.base,
        points: table(this.base, 'points').map((p) => {
          const at = ends.get(p.id as string);
          return at ? { ...p, x: at[0], y: at[1] } : p;
        }),
        curves: table(this.base, 'curves').map((c) => (c.id === curve && c.kind === 'circle' ? { ...c, radius } : c)),
      };
      holds.push({
        id: 'con_drag0',
        kind: 'radius',
        active: flag,
        curve: curveOperand(curve),
        value: { id: 'val_dragr', def: { expr: { text: `${radius} mm`, grammar: 1, refs: {} } } },
        solved: radius,
        label: { auto: {} },
      });
    }
    const held = { ...moved, constraints: [...table(moved, 'constraints'), ...holds] };
    let solved = solveInputs(this.gcs, this.values, held, this.externals);
    if (!solved.ok) solved = solveInputs(this.gcs, this.values, moved, this.externals);
    if (solved.ok) {
      const constraints = table(solved.inputs, 'constraints').filter((c) => !String(c.id).startsWith('con_drag'));
      this.working = { ...solved.inputs, constraints };
      this.geometry = this.geometryOf(this.working);
      this.dof = solved.dof;
      this.toolState = { ...s, moved: true };
    }
    this.changed();
  }

  private endDrag(moved: boolean): void {
    const working = this.working;
    if (!moved || working === this.base) return;
    const update: RowUpdate[] = [];
    for (const p of table(working, 'points')) {
      const before = table(this.stored, 'points').find((q) => q.id === p.id);
      if (before && (before.x !== p.x || before.y !== p.y))
        update.push({ id: p.id as string, set: { x: p.x, y: p.y } });
    }
    for (const c of table(working, 'curves')) {
      const before = table(this.stored, 'curves').find((q) => q.id === c.id);
      if (before && c.kind === 'circle' && before.radius !== c.radius)
        update.push({ id: c.id as string, set: { radius: c.radius } });
    }
    this.restoreWorking();
    if (update.length > 0) this.commit({ label: 'Drag', update });
  }

  /** Drops a drag's working copy: what is shown, and its degrees of freedom, are the solved stored rows again. */
  private restoreWorking(): void {
    if (this.working === this.base) return;
    this.working = this.base;
    this.geometry = this.geometryOf(this.base);
    this.dof = this.baseDof;
  }

  /**
   * Abandons the gesture in progress (a press, drag or box), as when the
   * pointer is released where the sketch cannot see it: a drag puts back
   * what it moved and writes nothing.
   */
  cancelGesture(): void {
    const s = this.toolState;
    if (s.kind !== 'press' && s.kind !== 'drag' && s.kind !== 'box') return;
    this.toolState = { kind: 'idle' };
    this.restoreWorking();
    this.changed();
  }

  // ---- constraints chosen first ----

  /** The point or curve a click picks for the constraint tool: curves only for constraints between curves. */
  private constraintPick(uv: P2, kind: ConstraintKind): string | null {
    const curvesOnly = CURVE_CONSTRAINTS.has(kind);
    const picked = this.pick(uv, this.pixel, curvesOnly ? new Set(this.geometry.points.keys()) : undefined, true);
    if (!picked || !curvesOnly) return picked;
    return picked === STANDARD_IDS.origin || this.geometry.curves.get(picked)?.kind === 'point' ? null : picked;
  }

  private constrainPointer(e: SketchPointer, uv: P2): boolean {
    const kind = this.constraintKind;
    if (!kind) return false;
    const picked = this.constraintPick(uv, kind);
    if (e.type === 'move') {
      if (picked !== this.hover) {
        this.hover = picked;
        this.changed();
      }
      return true;
    }
    if (e.type === 'up' || !picked || this.selection.includes(picked)) return true;
    const picks = [...this.selection, picked];
    const step = constraintPickStep(kind, sortSelection(this.geometry, picks), picks.length);
    this.selection = picks;
    if (step === 'more') {
      this.message = null;
      this.changed();
      return true;
    }
    if (step === 'refuse') {
      this.selection = [];
      this.refuse(constraintReason(kind));
      return true;
    }
    const result = this.applyConstraint(kind);
    this.selection = [];
    if (result.ok) this.message = null;
    this.changed();
    return true;
  }

  // ---- the drawing tools ----

  private drawPointer(e: SketchPointer, uv: P2): boolean {
    if (e.type === 'up') return this.currentTool === 'line' ? this.lineUp(uv) : true;
    const snap = this.snapFor(uv);
    this.snap = snap;
    if (e.type === 'move') {
      this.lineDrag(uv);
      this.rebuild();
      return true;
    }
    const s = this.toolState;
    switch (this.currentTool) {
      case 'line':
        if (s.kind !== 'line') this.toolState = { kind: 'line', start: snap, press: uv };
        else if (snap.kind === 'point' && s.start.kind === 'point' && snap.id === s.start.id)
          this.toolState = { ...s, press: uv };
        else this.drawLine(s.start, snap);
        break;
      case 'rectangle':
        if (s.kind !== 'rectangle') this.toolState = { kind: 'rectangle', first: snap };
        else this.drawRectangle(s.first, snap);
        break;
      case 'circle':
        if (s.kind !== 'circle') this.toolState = { kind: 'circle', center: snap };
        else this.drawCircle(s.center, snap);
        break;
      case 'arc':
        if (s.kind !== 'arc') this.toolState = { kind: 'arc', start: snap };
        else if (!s.end) {
          if (near(s.start.at, snap.at) > 1e-9) this.toolState = { ...s, end: snap };
        } else this.drawArc(s.start, s.end, snap.at);
        break;
      case 'point':
        this.drawPoint(snap);
        break;
    }
    this.changed();
    return true;
  }

  /** A press held at the start of a line moves far enough from the end of a line or arc: the drag draws a tangent arc. */
  private lineDrag(uv: P2): void {
    const s = this.toolState;
    if (s.kind !== 'line' || !s.press || near(uv, s.press) < DRAG_PIXELS * this.pixel) return;
    const start = s.start;
    if (start.kind !== 'point' || !leavingDirection(this.geometry, start.id)) {
      this.toolState = { kind: 'line', start };
      return;
    }
    this.toolState = { kind: 'lineArc', start };
  }

  /** The button comes up with the line tool: a dragged tangent arc ends there, and the chain goes on from its end. */
  private lineUp(uv: P2): boolean {
    const s = this.toolState;
    if (s.kind === 'line' && s.press) {
      this.toolState = { kind: 'line', start: s.start };
      return true;
    }
    if (s.kind !== 'lineArc') return true;
    const end = this.snapFor(uv);
    const d = this.draft();
    const refused = SHAPES.tangentArc.build(d, [s.start, end], this.shapeContext());
    this.toolState = { kind: 'line', start: s.start };
    if (refused) {
      this.refuse(refused);
      return true;
    }
    const arc = d.curves[0] as Json;
    const result = this.commit(d.change('Draw tangent arc'));
    if (!result.ok) return true;
    const next = arc.start === s.start.id ? (arc.end as string) : (arc.start as string);
    const at = this.geometry.point(next);
    this.toolState = at ? { kind: 'line', start: { kind: 'point', id: next, at } } : { kind: 'idle' };
    this.changed();
    return true;
  }

  private draft(): Draft {
    return new Draft(this.make);
  }

  private shapeContext(sweep = 0): ShapeContext {
    return {
      geometry: this.geometry,
      construction: this.construction,
      pixel: this.pixel,
      sides: this.settings.sides,
      sweep,
    };
  }

  /** The shape tools: each click is snapped and kept, and the shape is drawn once it has all its clicks. */
  private shapePointer(e: SketchPointer, uv: P2): boolean {
    if (e.type === 'up') return true;
    const tool = this.currentTool as ShapeTool;
    const spec = SHAPES[tool];
    const snap = this.snapFor(uv);
    this.snap = snap;
    const s = this.toolState.kind === 'shape' && this.toolState.tool === tool ? this.toolState : null;
    if (e.type === 'move') {
      // The centre-point arc follows the pointer's turn about the centre, so its sweep can pass half a turn.
      if (s && tool === 'arcCenter' && s.snaps.length === 2) {
        const c = (s.snaps[0] as Snap).at;
        const angle = Math.atan2(snap.at[1] - c[1], snap.at[0] - c[0]);
        const last = s.angle ?? Math.atan2((s.snaps[1] as Snap).at[1] - c[1], (s.snaps[1] as Snap).at[0] - c[0]);
        const turn = Math.atan2(Math.sin(angle - last), Math.cos(angle - last));
        this.toolState = { ...s, sweep: s.sweep + turn, angle };
      }
      this.rebuild();
      return true;
    }
    const snaps = s ? [...s.snaps] : [];
    if (snaps.length === 0 && spec.start) {
      const refused = spec.start(snap, this.shapeContext());
      if (refused) {
        this.refuse(refused);
        return true;
      }
    }
    // A click on the spline's last point finishes it.
    const last = snaps[snaps.length - 1];
    if (
      tool === 'spline' &&
      last &&
      near(last.at, snap.at) <= 1e-9 * Math.max(1, Math.abs(snap.at[0]) + Math.abs(snap.at[1]))
    )
      return this.finishShape();
    if (last && near(last.at, snap.at) < 1e-9) return true;
    snaps.push(snap);
    const sweep = s?.sweep ?? 0;
    if (snaps.length < spec.clicks) {
      this.toolState = { kind: 'shape', tool, snaps, sweep, angle: s?.angle ?? null };
      this.changed();
      return true;
    }
    this.buildShape(tool, snaps, sweep);
    return true;
  }

  private buildShape(tool: ShapeTool, snaps: readonly Snap[], sweep: number): boolean {
    const spec = SHAPES[tool];
    const d = this.draft();
    const refused = spec.build(d, snaps, this.shapeContext(sweep));
    this.toolState = { kind: 'idle' };
    if (refused) {
      this.refuse(refused);
      return true;
    }
    this.commit(d.change(spec.label));
    this.changed();
    return true;
  }

  /** Ends the spline with the points placed so far. */
  private finishShape(): boolean {
    const s = this.toolState;
    if (s.kind !== 'shape') return false;
    if (s.snaps.length < 2) {
      this.toolState = { kind: 'idle' };
      this.changed();
      return true;
    }
    return this.buildShape(s.tool, s.snaps, s.sweep);
  }

  private modifyContext(): ModifyContext {
    return {
      inputs: this.stored,
      geometry: this.geometry,
      make: this.make,
      active: (c) => flagOn(this.values, c.active),
      pixel: this.pixel,
    };
  }

  private applyPlan(plan: ModifyPlan): CommandResult {
    if (!plan.ok) return this.refuse(plan.message);
    return this.commit(plan.change);
  }

  /**
   * Trim, extend and offset act on the curve clicked; fillet on a corner
   * point or two lines in turn; mirror on the selection, across the line
   * clicked (a sketch axis too).
   */
  private modifyPointer(e: SketchPointer, uv: P2): boolean {
    const tool = this.currentTool as string;
    const mirror = tool === 'mirror';
    const fillet = tool === 'fillet';
    // Fillet takes corner points; the others take curves, so a click by a curve's end still finds the curve.
    const points = fillet ? undefined : new Set([...this.geometry.points.keys()]);
    const found = this.pick(uv, this.pixel, points, mirror);
    const picked = found !== null && !fillet && this.geometry.curves.get(found)?.kind === 'point' ? null : found;
    if (e.type === 'move') {
      const hover = picked;
      if (hover !== this.hover) {
        this.hover = hover;
        this.changed();
      }
      return true;
    }
    if (e.type === 'up') return true;
    if (!picked) return true;
    const ctx = this.modifyContext();
    switch (tool) {
      case 'trim':
        this.applyPlan(planTrim(ctx, picked, uv));
        break;
      case 'extend':
        this.applyPlan(planExtend(ctx, picked, uv));
        break;
      case 'offset': {
        // The click picks the curve and the side; the dialog sets the rest, and OK writes it.
        const side = offsetSide(ctx, picked, uv);
        if (side === null) {
          this.refuse('Offset works on lines, arcs and circles');
          break;
        }
        this.toolState = { kind: 'offset', curve: picked, side };
        this.selection = [picked];
        this.message = null;
        this.changed();
        break;
      }
      case 'fillet': {
        const point =
          this.geometry.curves.get(picked)?.kind === 'point'
            ? (this.geometry.curves.get(picked)?.row.at as string)
            : picked;
        const s = this.toolState;
        const corner = this.geometry.points.has(point);
        const picks = corner ? [point] : s.kind === 'fillet' ? [s.first, picked] : null;
        if (!picks) {
          this.toolState = { kind: 'fillet', first: picked };
          this.selection = [picked];
          this.changed();
          break;
        }
        this.toolState = { kind: 'idle' };
        this.selection = [];
        const name = freeValueName(this.doc, this.host.part, 'd');
        this.applyPlan(
          planFillet(ctx, picks, this.settings.fillet, { name, text: valueText(this.settings.fillet, false) }),
        );
        break;
      }
      case 'mirror': {
        const result = this.applyPlan(planMirror(ctx, this.selection, picked));
        if (result.ok) this.selection = [];
        this.changed();
        break;
      }
    }
    return true;
  }

  /** The Offset dialog's edit for the curve and side picked, with its distances and direction; null with no curve picked. */
  private offsetPlan(): ModifyPlan | null {
    const s = this.toolState;
    if (s.kind !== 'offset') return null;
    const first = freeValueName(this.doc, this.host.part, 'd');
    const second = freeValueName(this.doc, this.host.part, 'd', [first]);
    const { offset, offset2, offsetDirection } = this.settings;
    return planOffsets(
      this.modifyContext(),
      s.curve,
      s.side,
      offsetDirection,
      [offset, offset2],
      [first, second],
      (n) => valueText(n, false),
    );
  }

  /** Turns the Offset dialog's one side over to the other side of the curve. */
  flipOffset(): void {
    const s = this.toolState;
    if (s.kind !== 'offset') return;
    this.toolState = { ...s, side: s.side === 1 ? -1 : 1 };
    this.changed();
  }

  /** The Offset dialog's OK: writes the offset previewed and closes the dialog back to Select. */
  confirmOffset(): CommandResult {
    const plan = this.offsetPlan();
    if (!plan) return this.refuse('Click the curve to offset');
    const result = this.applyPlan(plan);
    if (result.ok) this.setTool('select');
    return result;
  }

  /** The copies the Offset dialog would add, drawn as a preview. */
  private offsetPreview(): PreviewShape[] {
    const plan = this.offsetPlan();
    if (!plan?.ok) return [];
    const added = plan.change.add ?? {};
    const made = new Map((added.points ?? []).map((p) => [p.id as string, [p.x, p.y] as P2]));
    const at = (id: unknown) => made.get(id as string) ?? this.geometry.point(id as string);
    return (added.curves ?? []).flatMap((c): PreviewShape[] => {
      if (c.kind === 'line') {
        const [a, b] = [at(c.start), at(c.end)];
        return a && b ? [{ kind: 'polyline', points: [a, b] }] : [];
      }
      const center = at(c.center);
      if (!center) return [];
      if (c.kind === 'circle') return [{ kind: 'circle', center, radius: c.radius as number }];
      const [from, to] = [at(c.start), at(c.end)];
      return from && to ? [{ kind: 'arc', center, radius: near(center, from), from, to }] : [];
    });
  }

  /** One segment; the next starts at its end, as a chain of lines sharing points. A segment ending on an existing point ends the chain. */
  private drawLine(start: Snap, end: Snap): void {
    if (near(start.at, end.at) < 1e-9) return;
    if (start.kind === 'point' && end.kind === 'point' && start.id === end.id) return;
    const d = this.draft();
    const a = d.place(start);
    const b = d.place(end);
    const line = this.make.line(a, b, this.construction);
    d.curves.push(line);
    const free = end.kind !== 'point' && end.kind !== 'origin' && end.kind !== 'midpoint';
    const axis = free ? inferAxis(start.at, end.at, this.pixel) : null;
    if (axis) d.constrain(axis, { of: { curve: { id: line.id } } }, true);
    const result = this.commit(d.change('Draw line'));
    if (!result.ok) return;
    const at = this.geometry.point(b);
    this.toolState =
      end.kind === 'point' || end.kind === 'origin' || !at
        ? { kind: 'idle' }
        : { kind: 'line', start: { kind: 'point', id: b, at } };
  }

  /** Four lines sharing corner points, horizontal and vertical by constraint: a rectangle is lines and constraints. */
  private drawRectangle(first: Snap, second: Snap): void {
    const [x1, y1] = first.at;
    const [x2, y2] = second.at;
    if (Math.abs(x2 - x1) < 1e-6 || Math.abs(y2 - y1) < 1e-6) return;
    const d = this.draft();
    const p0 = d.place(first);
    const p1 = d.point([x2, y1]);
    const p2 = d.place(second);
    const p3 = d.point([x1, y2]);
    const corners = [p0, p1, p2, p3];
    const lines = corners.map((p, i) => this.make.line(p, corners[(i + 1) % 4] as string, this.construction));
    d.curves.push(...lines);
    lines.forEach((l, i) =>
      d.constrain(i % 2 === 0 ? 'horizontal' : 'vertical', { of: { curve: { id: l.id } } }, true),
    );
    if (this.commit(d.change('Draw rectangle')).ok) this.toolState = { kind: 'idle' };
  }

  private drawCircle(center: Snap, rim: Snap): void {
    const radius = near(center.at, rim.at);
    if (radius < 1e-6) return;
    const d = this.draft();
    d.curves.push(this.make.circle(d.place(center), radius, this.construction));
    if (this.commit(d.change('Draw circle')).ok) this.toolState = { kind: 'idle' };
  }

  /** An arc through three points: its start, its end, then a point it passes. */
  private drawArc(start: Snap, end: Snap, through: P2): void {
    const circle = circumcircle(start.at, through, end.at);
    if (!circle) return;
    const d = this.draft();
    const s = d.place(start);
    const e = d.place(end);
    const center = d.point(circle.center);
    const ccw = passesCounterClockwise(circle.center, start.at, through, end.at);
    d.curves.push(
      ccw ? this.make.arc(center, s, e, this.construction) : this.make.arc(center, e, s, this.construction),
    );
    if (this.commit(d.change('Draw arc')).ok) this.toolState = { kind: 'idle' };
  }

  private drawPoint(snap: Snap): void {
    if (snap.kind === 'point') return;
    const d = this.draft();
    d.curves.push(this.make.pointCurve(d.place(snap), this.construction));
    this.commit(d.change('Draw point'));
  }

  // ---- the dimension tools ----

  private dimensionMode(): DimensionMode {
    return this.currentTool === 'dimensionX' ? 'x' : this.currentTool === 'dimensionY' ? 'y' : 'free';
  }

  /**
   * Pick an entity, then a second one to dimension the two, or empty space
   * to dimension the first alone with its label there.
   */
  /**
   * Whether the dimension tool picks the sketch origin and axes now: freely
   * first, or second after a point or round curve. After a line, a click by
   * an axis places the label instead; an angle to an axis picks the axis first.
   * Along an axis, only the origin is a target.
   */
  private standardPickable(first: string | null): boolean | 'origin' {
    if (this.dimensionMode() !== 'free') return first !== STANDARD_IDS.origin ? 'origin' : false;
    if (first === null) return true;
    const kind = this.geometry.curves.get(first)?.kind;
    return kind !== 'line' && !standardName(first);
  }

  private dimensionPointer(e: SketchPointer, uv: P2): boolean {
    if (e.type === 'move') {
      const s = this.toolState;
      const hover = this.pick(
        uv,
        this.pixel,
        undefined,
        this.standardPickable(s.kind === 'dimension' ? s.first : null),
      );
      if (hover !== this.hover) {
        this.hover = hover;
        this.changed();
      }
      return true;
    }
    if (e.type === 'up') return true;
    const s = this.toolState;
    const picked = this.pick(uv, this.pixel, undefined, this.standardPickable(s.kind === 'dimension' ? s.first : null));
    if (s.kind !== 'dimension') {
      if (picked) {
        this.toolState = { kind: 'dimension', first: picked };
        this.selection = [picked];
        this.changed();
      }
      this.rebuild();
      return true;
    }
    const picks = picked && picked !== s.first ? [s.first, picked] : [s.first];
    this.placeDimension(picks, picked && picked !== s.first ? null : uv);
    this.toolState = { kind: 'idle' };
    this.selection = [];
    this.changed();
    return true;
  }

  private placeDimension(picks: string[], labelAt: P2 | null): CommandResult {
    const plan = planDimension(this.geometry, picks, this.dimensionMode());
    if (!plan)
      return this.refuse(
        picks.length === 1 ? 'That cannot be dimensioned alone' : 'Those cannot be dimensioned together',
      );
    const name = freeValueName(this.doc, this.host.part, 'd');
    const value = this.make.value(valueText(plan.value, plan.kind === 'angle'), name);
    const label = labelAt ? { at: { p: [labelAt[0], labelAt[1]] } } : { auto: {} };
    const row = this.make.dimension(plan.kind, plan.fields, value, plan.value, label);
    const result = this.commit({ label: 'Add dimension', add: { constraints: [row] } });
    if (result.ok) {
      this.editing = row.id as string;
      this.changed();
    }
    return result;
  }

  private escape(): boolean {
    const s = this.toolState;
    if (s.kind !== 'idle') {
      this.toolState = { kind: 'idle' };
      this.restoreWorking();
      if (s.kind === 'dimension') this.selection = [];
      this.changed();
      return true;
    }
    if (this.currentTool === 'constrain' && this.selection.length > 0) {
      this.clearSelection();
      return true;
    }
    if (this.currentTool !== 'select' && this.currentTool !== null) {
      this.setTool('select');
      return true;
    }
    if (this.selection.length > 0) {
      this.clearSelection();
      return true;
    }
    return false;
  }

  // ---- drawing and state ----

  private toPart(p: P2): [number, number, number] {
    const { origin: o, x, y } = this.host.frame;
    return [o[0] + x[0] * p[0] + y[0] * p[1], o[1] + x[1] * p[0] + y[1] * p[1], o[2] + x[2] * p[0] + y[2] * p[1]];
  }

  private preview(): PreviewShape[] {
    const s = this.toolState;
    const at = this.snap?.at ?? this.cursor;
    if (!at) return [];
    switch (s.kind) {
      case 'line':
        return [{ kind: 'polyline', points: [s.start.at, at] }];
      case 'lineArc':
        return SHAPES.tangentArc.preview([s.start.at], at, this.shapeContext(), [s.start]);
      case 'rectangle': {
        const [a, b] = [s.first.at, at];
        return [{ kind: 'polyline', points: [a, [b[0], a[1]], b, [a[0], b[1]], a] }];
      }
      case 'circle':
        return [{ kind: 'circle', center: s.center.at, radius: near(s.center.at, at) }];
      case 'arc': {
        if (!s.end) return [{ kind: 'polyline', points: [s.start.at, at] }];
        const circle = circumcircle(s.start.at, at, s.end.at);
        if (!circle) return [{ kind: 'polyline', points: [s.start.at, s.end.at] }];
        const ccw = passesCounterClockwise(circle.center, s.start.at, at, s.end.at);
        const [from, to] = ccw ? [s.start.at, s.end.at] : [s.end.at, s.start.at];
        return [{ kind: 'arc', center: circle.center, radius: circle.radius, from, to }];
      }
      case 'box':
        return [{ kind: 'box', from: s.from, to: s.to, crossing: s.to[0] < s.from[0] }];
      case 'idle':
        return this.currentTool === 'text' ? this.textPreview(at) : [];
      case 'offset':
        return this.offsetPreview();
      case 'shape':
        return SHAPES[s.tool].preview(
          s.snaps.map((q) => q.at),
          at,
          this.shapeContext(s.sweep),
          s.snaps,
        );
      default:
        return [];
    }
  }

  private hint(): { kind: 'horizontal' | 'vertical'; at: P2 } | null {
    const s = this.toolState;
    const snap = this.snap;
    if (s.kind !== 'line' || !snap || snap.kind === 'point' || snap.kind === 'origin' || snap.kind === 'midpoint')
      return null;
    const axis = inferAxis(s.start.at, snap.at, this.pixel);
    return axis ? { kind: axis, at: snap.at } : null;
  }

  /** The regions of what is shown, detected again only when that changes. */
  private regions(): Detection | null {
    if (!this.options.profile) return null;
    const glyphs = this.textCurves();
    const held = this.detectedFor;
    if (
      held &&
      held.working === this.working &&
      held.values === this.values &&
      held.externals === this.externals &&
      held.glyphs === glyphs
    )
      return this.detection;
    this.detectedFor = { working: this.working, values: this.values, externals: this.externals, glyphs };
    const sketch = solvedSketchOf(this.working, this.values, this.externals, glyphs);
    try {
      this.detection = sketch ? detectRegions(sketch) : null;
    } catch {
      this.detection = null;
    }
    return this.detection;
  }

  private rebuild(): void {
    if (!this.open) return;
    const t = this.currentTool;
    const drawingTool =
      t === 'line' || t === 'rectangle' || t === 'circle' || t === 'arc' || t === 'point' || t === 'text' || isShape(t);
    const view: DrawingView = {
      geometry: this.geometry,
      selection: new Set(this.selection),
      hover: this.hoverSet(),
      options: this.options,
      fullyDefined: this.dof === 0,
      detection: this.regions(),
      preview: this.preview(),
      snap: drawingTool ? this.snap : null,
      hint: this.hint(),
      gridSpacing: GRID_SPACING,
      glyphs: (this.textCurves() ?? []).flatMap((g) => {
        const curve = 'glyph' in g.key ? prepareCurve(g.shape, false) : null;
        return curve && 'glyph' in g.key
          ? [{ text: g.key.glyph.text, polyline: curve.flatten(curve.tMin, curve.tMax, 2) }]
          : [];
      }),
    };
    this.drawing.update(view);
    this.host.requestRender();
  }

  /** What draws as hovered: the hovered entity, or for a hovered constraint the points and curves it holds. */
  private hoverSet(): Set<string> {
    const id = this.hover;
    if (id === null) return new Set();
    const row = table(this.stored, 'constraints').find((c) => c.id === id);
    if (!row) return new Set([id]);
    const out = new Set<string>();
    for (const named of namedIds(row))
      if (this.geometry.points.has(named) || this.geometry.curves.has(named)) out.add(named);
    for (const name of standardsOf(row)) out.add(STANDARD_IDS[name]);
    return out;
  }

  /** The constraints that show glyphs; rows standing as one constraint show one glyph, a point held on the origin a Coincident one. */
  private glyphRows(): Json[] {
    const linked = this.linked();
    return table(this.working, 'constraints').flatMap((c): Json[] => {
      if (DIMENSION_KINDS.has(c.kind as string) || !flagOn(this.values, c.active)) return [];
      const link = linked.get(c.id as string);
      if (!link) return [c];
      if (link.lead !== c.id) return [];
      if (link.kind === 'offset') return [c];
      const points = (c.of as Json).points as Json;
      return [{ id: c.id, kind: 'coincident', point: standardOf(points.a) === 'origin' ? points.b : points.a }];
    });
  }

  private snapshot(): SketchSessionState {
    const constraints = table(this.stored, 'constraints');
    const linked = this.linked();
    // A row of a group stands as the one constraint the group is, by its lead.
    const shown = (c: Json): { id: string; kind: string } => {
      const link = linked.get(c.id as string);
      return link ? { id: link.lead, kind: link.kind } : { id: c.id as string, kind: c.kind as string };
    };
    const selected = this.selection.map((id) => {
      const curve = this.geometry.curves.get(id);
      const constraint = constraints.find((c) => c.id === id);
      const kind = curve
        ? curve.kind
        : constraint
          ? shown(constraint).kind
          : regionIndex(id) !== null
            ? 'region'
            : 'point';
      const named = curve?.kind === 'point' ? (curve.row.at as string) : id;
      const on = new Map<string, { id: string; kind: string }>();
      for (const c of constraints) {
        if (!namedIds(c).has(named)) continue;
        const s = shown(c);
        if (s.id !== id) on.set(s.id, s);
      }
      return { id, kind, construction: curve?.construction ?? false, constraints: [...on.values()] };
    });
    const fits = fittingConstraints(sortSelection(this.geometry, this.selection));
    return {
      tool: this.currentTool,
      constraint: this.constraintKind,
      selection: [...this.selection],
      hover: this.hover,
      construction: this.construction,
      options: this.options,
      message: this.message,
      dof: this.dof,
      editing: this.editing,
      fits,
      counts: {
        points: table(this.stored, 'points').length,
        curves: table(this.stored, 'curves').length,
        constraints: constraints.length,
      },
      selected,
      details: this.selection.length === 1 ? selectedDetails(this.geometry, this.selection[0] as string) : null,
      open: this.open,
      settings: this.settings,
      prompt: this.prompt(),
      offsetCurve: this.toolState.kind === 'offset' ? this.toolState.curve : null,
      text: { ...this.textOptions, editing: this.textEditing, heldFont: this.textHeldFont },
    };
  }

  /** What the tool in progress takes next. */
  private prompt(): string | null {
    const s = this.toolState;
    const tool = this.currentTool;
    if (isShape(tool)) {
      const n = s.kind === 'shape' ? s.snaps.length : 0;
      const steps: Record<ShapeTool, string[]> = {
        centerRectangle: ['Click the centre', 'Click a corner'],
        circle2: ['Click one end of the diameter', 'Click the other end'],
        circle3: ['Click a point on the circle', 'Click a second point', 'Click a third point'],
        arcCenter: ['Click the centre', 'Click the start', 'Click the end'],
        tangentArc: ['Click the end of a line or arc', 'Click the end of the arc'],
        polygon: ['Click the centre', 'Click a corner'],
        polygonCircumscribed: ['Click the centre', 'Click the middle of a side'],
        polygonEdge: ['Click one end of a side', 'Click the other end', 'Click the side to build it on'],
        slot: ['Click the first centre', 'Click the second centre', 'Click to set the width'],
        ellipse: ['Click the centre', 'Click the end of an axis', 'Click to set the other axis'],
        spline: ['Click the first point', 'Click the next point; Enter or Escape ends the spline'],
      };
      const list = steps[tool];
      return list[Math.min(n, list.length - 1)] ?? null;
    }
    switch (tool) {
      case 'trim':
        return 'Click the part of a curve to remove';
      case 'extend':
        return 'Click near the end to extend';
      case 'offset': {
        if (s.kind !== 'offset') return 'Click a curve on the side to offset to';
        const plan = this.offsetPlan();
        return plan && !plan.ok ? plan.message : 'Set the distance, then OK';
      }
      case 'fillet':
        return s.kind === 'fillet' ? 'Click the second line' : 'Click a corner, or the first line';
      case 'mirror':
        return this.selection.some((id) => this.geometry.curves.has(id))
          ? 'Click the line to mirror across'
          : 'Select the curves to mirror first';
      case 'project':
        return 'Click model edges or faces to project';
      case 'intersect':
        return 'Click model faces to cut with the sketch plane';
      case 'text':
        return 'Click where the text starts';
      case 'constrain':
        return this.constraintKind ? CONSTRAINT_PROMPTS[this.constraintKind] : null;
      default:
        return null;
    }
  }

  /** Redraws, and tells the listeners the state changed. */
  private changed(): void {
    this.rebuild();
    this.state = this.snapshot();
    for (const listener of [...this.listeners]) listener();
  }
}

function segmentCrossesBox(a: P2, b: P2, x0: number, y0: number, x1: number, y1: number): boolean {
  // Liang–Barsky clipping: the segment meets the box when some part of it survives.
  let [t0, t1] = [0, 1];
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const edges: [number, number][] = [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

/** The sketch origin and axes a row names, at any depth. */
function standardsOf(value: unknown, out: StandardName[] = []): StandardName[] {
  const name = standardOf(value);
  if (name) out.push(name);
  else if (Array.isArray(value)) for (const v of value) standardsOf(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value))
      if (k !== 'value' && k !== 'active' && k !== 'extensions') standardsOf(v, out);
  }
  return out;
}
