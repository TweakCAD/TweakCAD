/**
 * A FreeCAD document as a version-2 document. Each PartDesign Body becomes a
 * part whose timeline holds its features in their FreeCAD order, in the
 * Body's own coordinates; a file whose Bodies are not one Body at the origin
 * gets an assembly placing each part where its Body is.
 *
 * FreeCAD stores the solved result of every attachment (a sketch's or datum's
 * `Placement`, a revolution's axis), so sketches, datums, primitives, pads,
 * pockets, revolutions, holes, patterns and mirrors convert without the
 * kernel. Fillets and chamfers name edges of the shape FreeCAD built
 * (`Edge3`), and a pad can take a face of one; those become references only
 * once the document is evaluated. A Body's base shape and the Part workbench's
 * solids come in as the shapes FreeCAD stored, `core.import` with
 * `{"kept": {}}` (13.3). Both are returned as steps for `complete` to finish.
 */
import { makeSet } from '@tweakcad/format';
import type { IdGenerator } from '@tweakcad/editor';
import {
  bool,
  enumeration,
  float,
  has,
  integer,
  IDENTITY,
  link,
  links,
  placement,
  shapeFile,
  vector,
  type FcDocument,
  type FcLink,
  type FcObject,
  type FcPlacement,
  type Vec3,
} from './document';
import {
  apply,
  compose,
  deg,
  invert,
  isIdentity,
  mm,
  numberText,
  placementOfFrame,
  rotate,
  vectorText,
} from './placement';
import { circleRows, convertSketch, outlineRows, type ConvertedSketch, type OutlineStep } from './sketch';
import { isDefaultColor, readAppearances } from './appearance';
import { Parameters, type ValueScope } from './parameters';
import { Writer, type Json, type PartDraft } from './writer';

export interface ImportNote {
  severity: 'info' | 'warning';
  /** The FreeCAD object's label, or the document for notes about the whole file. */
  object: string;
  message: string;
}

interface StepBase {
  /** It comes after the Body's Tip, so the part rolls back to before it unless it already does to something earlier. */
  pastTip?: boolean;
  part: string;
  /** The feature the new one goes before in its part, or undefined for the end. */
  before: string | undefined;
  /** The FreeCAD object's label. */
  object: string;
  /** The id the feature row takes, which later features may already name. */
  id: string;
}

/** A feature that references entities of the evaluated model, found by geometry in a shape FreeCAD stored. */
export interface LocateStep extends StepBase {
  kind: 'locate';
  /** FreeCAD's stored shape the entities belong to, as BREP text. */
  shape: string;
  entity: 'edge' | 'face';
  /** 0-based indices into that shape's entities of the kind, or all of them. */
  indices: number[] | 'all';
  /** 0-based indices of faces of that shape whose edges are wanted as well. */
  ofFaces?: number[];
  /** Whether the row needs the part's live bodies as well. */
  needsBodies?: boolean;
  /** The feature row, given the references found and, when asked for, the live bodies. */
  row(refs: Json[], bodies: Json[]): Json;
}

/** A shape FreeCAD stored, read by the worker into a `core.import` that keeps no file. */
export interface ShapeStep extends StepBase {
  kind: 'shape';
  /** The BREP bytes. */
  brep: Uint8Array;
  name: string;
  /** It stands for what came before it: a feature that has no equivalent here, carrying the Body on. */
  replaces?: boolean;
  /** The feature row, given the stored shape. */
  row(stored: Json): Json;
}

export type Step = LocateStep | ShapeStep;

/** A solid feature and the shape FreeCAD stored for it, to compare with what it builds. */
export interface Check {
  part: string;
  feature: string;
  object: string;
  brep: Uint8Array;
  name: string;
  /** The feature's place taken by the stored shape. */
  row(stored: Json): Json;
  /** Another reading of what the file says, tried before the stored shape stands in. */
  alternative?: (row: Json) => void;
}

export interface Conversion {
  document: Json;
  steps: Step[];
  notes: ImportNote[];
  /** What `complete` compares the rebuilt model with. */
  checks: Check[];
  /** Body colours, for `complete` to set on the bodies each part ends with. */
  styles: BodyStyle[];
  /** FreeCAD expressions that came in as definitions, and those that stayed numbers. */
  expressions: { carried: number; dropped: number };
}

/** A Body's appearance as an attribute row, given a reference to a live body. */
export interface BodyStyle {
  part: string;
  row(target: Json): Json;
}

export interface ConvertOptions {
  ids: IdGenerator;
  /** `metadata.writer`. */
  writer: { app: string; version: string };
  /** The document name; the file's own label otherwise. */
  name?: string;
  /** `createdAt` and `updatedAt`. */
  now?: string;
  /** The archive's entries, for stored shapes. */
  files?: ReadonlyMap<string, Uint8Array>;
  /** The source file, kept as the imported document's origin (13.3). */
  source?: Uint8Array;
}

const STANDARD: Record<string, 'xy' | 'xz' | 'yz'> = { XY_Plane: 'xy', XZ_Plane: 'xz', YZ_Plane: 'yz' };
const AXES: Record<string, 'x' | 'y' | 'z'> = { X_Axis: 'x', Y_Axis: 'y', Z_Axis: 'z' };
/** The classes of an ISO metric thread on a FreeCAD Hole, which saves its choice by index alone. */
const THREAD_CLASSES = ['4G', '4H', '5G', '5H', '6G', '6H', '7G', '7H', '8G', '8H'];
/** The standard planes' frames in a part (9.1), as placements. */
const STANDARD_FRAMES: Record<'xy' | 'xz' | 'yz', FcPlacement> = {
  xy: IDENTITY,
  xz: placementOfFrame([0, 0, 0], [1, 0, 0], [0, 1, 0]),
  yz: placementOfFrame([0, 0, 0], [0, 0, -1], [1, 0, 0]),
};

/** PartDesign's solid features: what a Body's chain is made of. */
const SOLID_FEATURE = /^PartDesign::(?!Body$|Plane$|Line$|Point$|CoordinateSystem$|ShapeBinder$|SubShapeBinder$)/;

const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return l > 0 ? scale(v, 1 / l) : v;
};
type Op = 'new' | 'join' | 'cut';
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** What a sketch became: its feature, rows and frame. */
interface SketchOut {
  feature: string;
  rows: ConvertedSketch;
  /** A fresh copy of the sketch's attached frame, with new value ids, flipped when asked. */
  frame(flip?: boolean): Json;
  /** The sketch's placement in its Body. */
  placement: FcPlacement;
}

class BodyConverter {
  private readonly part: PartDraft;
  /** FreeCAD object name → the feature id it became. */
  private readonly features = new Map<string, string>();
  private readonly sketches = new Map<string, SketchOut>();
  /** Steps waiting for the next feature row, to know what they go before. */
  private pending: Step[] = [];
  private afterTip = false;
  /** The place of the object being converted in the part's order. */
  private order = 0;

  constructor(
    private readonly w: Writer,
    private readonly doc: FcDocument,
    private readonly members: readonly FcObject[],
    private readonly tip: string | undefined,
    label: string,
    private readonly notes: ImportNote[],
    private readonly steps: Step[],
    private readonly files: ReadonlyMap<string, Uint8Array>,
    private readonly checks: Check[],
    private readonly parameters: Parameters,
    /** The part each Body became, filled in as the Bodies convert. */
    private readonly partOfBody: ReadonlyMap<string, string> = new Map(),
  ) {
    this.part = w.part(label);
  }

  /** A length property as a value: bound to FreeCAD's expression on it when that reads parameters. */
  private length(o: FcObject, name: string): Json {
    const v = float(o, name);
    return this.parameters.value(o, name, mm(v), v, 'length', this.scope);
  }

  private angle(o: FcObject, name: string, fallback = 0): Json {
    const v = float(o, name, fallback);
    return this.parameters.value(o, name, deg(v), v, 'angle', this.scope);
  }

  /** Where a value of the object being converted lies. */
  private get scope(): ValueScope {
    return { part: this.part.id, order: this.order };
  }

  get partId(): string {
    return this.part.id;
  }

  private note(o: FcObject, severity: ImportNote['severity'], message: string): void {
    this.notes.push({ severity, object: o.label, message });
  }

  private add(o: FcObject, row: Json): string {
    const id = row.id as string;
    this.part.timeline.push(row);
    for (const s of this.pending) s.before = id;
    this.pending = [];
    this.features.set(o.name, id);
    this.check(o, id, row.type as string);
    return id;
  }

  /** A feature `complete` writes: it goes before whatever feature comes next. */
  private defer(o: FcObject, step: Step): void {
    if (this.afterTip) step.pastTip = true;
    this.steps.push(step);
    this.pending.push(step);
    this.features.set(o.name, step.id);
    this.check(o, step.id, 'deferred');
  }

  /** Has `complete` compare a solid feature with the shape FreeCAD stored for it. */
  private check(o: FcObject, feature: string, type: string): void {
    if (type === 'core.sketch' || type.startsWith('core.construction')) return;
    const brep = this.stored(o.name);
    if (!brep) return;
    this.checks.push({
      part: this.part.id,
      feature,
      object: o.label,
      brep,
      name: `${o.label}.brp`,
      row: (stored) => this.storedRow(o, feature, stored),
    });
  }

  private storedRow(o: FcObject, id: string, stored: Json): Json {
    const w = this.w;
    return w.feature(
      'core.import',
      o.label,
      {
        source: { kept: {} },
        stored,
        importer: { format: 'FreeCAD', version: this.doc.programVersion ?? '' },
        units: w.choice('mm'),
        upAxis: w.choice('y'),
      },
      this.suppressed(o),
      id,
    );
  }

  /** The bytes of a shape FreeCAD stored for `name`, if the file holds them: an object with no shape has an empty file. */
  private stored(name: string): Uint8Array | undefined {
    const o = this.doc.byName.get(name);
    const file = o && shapeFile(o);
    const bytes = file ? this.files.get(file) : undefined;
    return bytes && bytes.length > 0 ? bytes : undefined;
  }

  /** The origin feature a link names, by its role (`XY_Plane`, `Z_Axis`), which holds whichever Body's origin it is. */
  private role(name: string): string | undefined {
    const o = this.doc.byName.get(name);
    if (!o) return undefined;
    const role = o.props.get('Role')?.children[0]?.attrs.value;
    if (role) return role;
    return o.type === 'App::Plane' || o.type === 'App::Line' ? name.replace(/\d+$/, '') : undefined;
  }

  /** The Body's features in an order where each comes after what it uses (FreeCAD's tree can list them otherwise). */
  private ordered(): FcObject[] {
    // A MultiTransform's transformations are its data, not steps of their own.
    const inner = new Set(this.members.flatMap((o) => links(o, 'Transformations').map((l) => l.obj)));
    const members = this.members.filter((o) => !inner.has(o.name));
    const inBody = new Set(members.map((o) => o.name));
    const uses = (o: FcObject): string[] =>
      [...o.props.keys()]
        .flatMap((p) => {
          if (p === 'Group' || p === '_Body' || p === 'ExpressionEngine') return [];
          const single = link(o, p);
          return single ? [single.obj, ...links(o, p).map((l) => l.obj)] : links(o, p).map((l) => l.obj);
        })
        .filter((n) => n !== o.name && inBody.has(n));
    const done = new Set<string>();
    const out: FcObject[] = [];
    let left = [...members];
    while (left.length > 0) {
      const next = left.find((o) => uses(o).every((u) => done.has(u))) ?? (left[0] as FcObject);
      out.push(next);
      done.add(next.name);
      left = left.filter((o) => o !== next);
    }
    return out;
  }

  /**
   * The solid features of the Tip's chain: what its `BaseFeature` links reach,
   * and what builds on it past the Tip. A feature off the chain is in the Body
   * but not in its shape.
   */
  private chain(): Set<string> {
    const on = new Set<string>();
    for (let at = this.tip; at !== undefined && !on.has(at);) {
      on.add(at);
      const o = this.doc.byName.get(at);
      at = o ? link(o, 'BaseFeature')?.obj : undefined;
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const o of this.members) {
        const base = link(o, 'BaseFeature')?.obj;
        if (base !== undefined && on.has(base) && !on.has(o.name)) {
          on.add(o.name);
          grew = true;
        }
      }
    }
    return on;
  }

  /** The Body goes on from the shape FreeCAD stored for `o`, whatever it was. */
  private keepStored(o: FcObject): boolean {
    const bytes = this.stored(o.name);
    if (!bytes) return false;
    const id = this.w.ids('feat');
    this.defer(o, {
      kind: 'shape',
      part: this.part.id,
      before: undefined,
      object: o.label,
      id,
      brep: bytes,
      name: `${o.label}.brp`,
      replaces: true,
      row: (stored) => this.storedRow(o, id, stored),
    });
    return true;
  }

  convert(): void {
    const tip = this.tip;
    const chain = this.chain();
    for (const o of this.ordered()) {
      const before = this.part.timeline.length;
      const solid = SOLID_FEATURE.test(o.type) || (tip !== undefined && chain.has(o.name));
      if (tip !== undefined && solid && !chain.has(o.name)) {
        this.note(o, 'info', 'it is not on the Body’s chain of features, so it is not in its shape and was left out');
        continue;
      }
      const before2 = this.notes.length;
      this.order++;
      this.convertObject(o);
      // What has no equivalent here comes in as the shape FreeCAD stored for it.
      if (solid && !this.features.has(o.name) && this.keepStored(o)) {
        for (const n of this.notes.slice(before2))
          if (n.severity === 'warning' && n.object === o.label) n.severity = 'info';
        this.note(o, 'warning', `${o.type.replace(/^\w+::/, '')} came in as the shape FreeCAD stored`);
      }
      if (this.afterTip && this.part.timeline.length > before && this.part.rollbackBefore === undefined) {
        this.part.rollbackBefore = (this.part.timeline[before] as Json).id as string;
      }
      if (o.name === tip) this.afterTip = true;
    }
  }

  private convertObject(o: FcObject): void {
    switch (o.type) {
      case 'Sketcher::SketchObject':
        return this.sketch(o);
      case 'PartDesign::Pad':
      case 'PartDesign::Pocket':
        return this.extrude(o);
      case 'PartDesign::Revolution':
      case 'PartDesign::Groove':
        return this.revolve(o);
      case 'PartDesign::Hole':
        return this.hole(o);
      case 'PartDesign::LinearPattern':
      case 'PartDesign::PolarPattern':
        return this.pattern(o);
      case 'PartDesign::Mirrored':
        return this.mirror(o);
      case 'PartDesign::Fillet':
      case 'PartDesign::Chamfer':
        return this.dressUp(o);
      case 'PartDesign::AdditiveLoft':
      case 'PartDesign::SubtractiveLoft':
        return this.loft(o);
      case 'PartDesign::AdditivePipe':
      case 'PartDesign::SubtractivePipe':
        return this.pipe(o);
      case 'PartDesign::Thickness':
        return this.thickness(o);
      case 'PartDesign::Draft':
        return this.draft(o);
      case 'PartDesign::MultiTransform':
        return this.multiTransform(o);
      case 'PartDesign::AdditiveHelix':
      case 'PartDesign::SubtractiveHelix':
        return this.helix(o);
      case 'PartDesign::FeatureBase':
        return this.base(o);
      case 'PartDesign::AdditiveBox':
      case 'PartDesign::SubtractiveBox':
      case 'PartDesign::AdditiveCylinder':
      case 'PartDesign::SubtractiveCylinder':
      case 'PartDesign::AdditiveSphere':
      case 'PartDesign::SubtractiveSphere':
      case 'PartDesign::AdditiveCone':
      case 'PartDesign::SubtractiveCone':
      case 'PartDesign::AdditiveTorus':
      case 'PartDesign::SubtractiveTorus':
        return this.primitive(o);
      case 'PartDesign::AdditivePrism':
      case 'PartDesign::SubtractivePrism':
        return this.prism(o);
      case 'PartDesign::Boolean':
        return this.boolean(o);
      case 'PartDesign::Plane':
      case 'PartDesign::Line':
      case 'PartDesign::Point':
      case 'PartDesign::CoordinateSystem':
        return this.datum(o);
      case 'App::Origin':
      case 'App::Line':
      case 'App::Plane':
      case 'App::Point':
      case 'App::VarSet':
      case 'Spreadsheet::Sheet':
        return;
      case 'PartDesign::ShapeBinder':
      case 'PartDesign::SubShapeBinder':
        this.note(o, 'info', 'a shape binder has no feature here; what is built from it comes in as FreeCAD stored it');
        return;
      default:
        if (!SOLID_FEATURE.test(o.type)) this.note(o, 'info', `${o.type.replace(/^\w+::/, '')} is not imported`);
    }
  }

  private suppressed(o: FcObject): boolean {
    return bool(o, 'Suppressed');
  }

  private sketch(o: FcObject): void {
    const rows = convertSketch(o, this.w, (index, name, literal, number, quantity, valueName) => {
      const path =
        name && this.parameters.drives(o, `Constraints.${name}`) ? `Constraints.${name}` : `Constraints[${index}]`;
      return this.parameters.value(
        o,
        path,
        literal,
        number,
        quantity,
        this.scope,
        valueName,
        name ? `Constraints.${name}` : undefined,
      );
    });
    for (const n of rows.notes) this.note(o, n.severity, n.message);
    const at = placement(o);
    const supports = links(o, 'AttachmentSupport').length > 0 ? links(o, 'AttachmentSupport') : links(o, 'Support');
    const role = supports.length === 1 && supports[0]?.subs.length === 0 ? this.role(supports[0].obj) : undefined;
    const standard = role ? STANDARD[role] : undefined;
    const frame = (flip = false) =>
      standard
        ? this.w.frameOn(standard, compose(invert(STANDARD_FRAMES[standard]), at), flip)
        : this.w.frameOn('xy', at, flip);
    const id = this.add(o, this.w.feature('core.sketch', o.label, { frame: frame(), ...rows.inputs }));
    this.sketches.set(o.name, { feature: id, rows, frame, placement: at });
  }

  private profile(o: FcObject): SketchOut | undefined {
    const l = link(o, 'Profile') ?? link(o, 'Sketch');
    const s = l && this.sketches.get(l.obj);
    if (!s && l && l.subs.length > 0 && this.features.has(l.obj)) return undefined;
    if (!s) {
      this.note(
        o,
        'warning',
        l
          ? `its profile ${this.label(l.obj)} was not imported, so it was left out`
          : 'it has no profile and was left out',
      );
      return undefined;
    }
    if (l.subs.length > 0) this.note(o, 'info', 'it takes faces of the profile sketch; all of the sketch was used');
    if (s.rows.faces.length === 0) {
      this.note(o, 'warning', 'its profile sketch bounds no area, so it was left out');
      return undefined;
    }
    return s;
  }

  private label(name: string): string {
    return this.doc.byName.get(name)?.label ?? name;
  }

  private profiles(s: SketchOut): unknown {
    return makeSet(s.rows.faces.map((r) => this.w.sketchRef(s.feature, 'region', r)));
  }

  /** A FreeCAD Body is one solid that each additive feature fuses into: a join, which makes a body where there is none yet. */
  private nextOp(additive: boolean): Op {
    return additive ? 'join' : 'cut';
  }

  /** The faces of another feature a pad or pocket takes as its profile, as a step; false when it takes a sketch. */
  private faceProfile(
    o: FcObject,
    build: (profiles: Json[], direction: (reversed: boolean) => Json, id: string, op: Op) => Json,
  ): boolean {
    const l = link(o, 'Profile');
    if (!l || l.subs.length === 0 || this.sketches.has(l.obj)) return false;
    const faces = l.subs.flatMap((sub) => (/^Face\d+$/.test(sub) ? [Number(sub.slice(4)) - 1] : []));
    const bytes = this.stored(l.obj);
    if (!this.features.has(l.obj) || faces.length === 0 || !bytes) {
      this.note(o, 'warning', 'the faces it takes as its profile were not imported, so it was left out');
      return true;
    }
    const w = this.w;
    const id = w.ids('feat');
    // Counted now, as the row is built later.
    const op = this.nextOp(o.type === 'PartDesign::Pad');
    this.defer(o, {
      kind: 'locate',
      part: this.part.id,
      before: undefined,
      object: o.label,
      id,
      shape: new TextDecoder().decode(bytes),
      entity: 'face',
      indices: faces,
      row: (refs) =>
        build(refs, (reversed) => ({ normal: { ref: structuredClone(refs[0]), reversed: w.flag(reversed) } }), id, op),
    });
    return true;
  }

  private extrude(o: FcObject): void {
    const w = this.w;
    // Faces taken as a profile run only a length here, so with none recorded the shape FreeCAD stored stands in.
    const from = link(o, 'Profile');
    if (from && from.subs.length > 0 && !this.sketches.has(from.obj) && this.noDepth(o, false)) {
      this.note(o, 'warning', NO_DEPTH);
      return;
    }
    if (
      this.faceProfile(
        o,
        (profiles, direction, id, op) => this.extrudeRow(o, makeSet(profiles), direction, id, op) ?? {},
      )
    )
      return;
    const s = this.profile(o);
    if (!s) return;
    const direction = (reversed: boolean): Json => ({
      normal: { ref: { object: { feature: { id: s.feature } } }, reversed: w.flag(reversed) },
    });
    // Up to a face of a feature here: that face, found once the document is evaluated.
    const target = integer(o, 'Type') === 3 ? link(o, 'UpToFace') : undefined;
    const index = target && /^Face(\d+)$/.exec(target.subs[0] ?? '');
    const bytes = target && index && this.features.has(target.obj) ? this.stored(target.obj) : undefined;
    if (index && bytes) {
      // Written now: the references' names go in the name table before the document is made.
      const profiles = this.profiles(s);
      const id = w.ids('feat');
      const op = this.nextOp(o.type === 'PartDesign::Pad');
      this.defer(o, {
        kind: 'locate',
        part: this.part.id,
        before: undefined,
        object: o.label,
        id,
        shape: new TextDecoder().decode(bytes),
        entity: 'face',
        indices: [Number(index[1]) - 1],
        row: (refs) => this.extrudeRow(o, profiles, direction, id, op, refs[0]) ?? {},
      });
      this.eitherWay(o, id);
      return;
    }
    // Up to a plane: older files name a datum's only element, `Plane`.
    const plane =
      target && target.subs.every((sub) => sub === '' || sub === 'Plane')
        ? this.planeRef({ ...target, subs: [] })
        : undefined;
    const row = this.extrudeRow(o, this.profiles(s), direction, undefined, undefined, plane);
    if (!row) return;
    const id = this.add(o, row);
    if (plane) this.eitherWay(o, id);
  }

  /** Up to a face FreeCAD runs to whichever side the face lies on, so the other direction is a second reading of the extrude. */
  private eitherWay(o: FcObject, id: string): void {
    const check = this.checks.find((c) => c.feature === id);
    if (!check) return;
    check.alternative = (row) => {
      const along = Object.values((row.inputs as Json).direction as Json)[0] as Json;
      along.reversed = this.w.flag((o.type === 'PartDesign::Pad') !== bool(o, 'Reversed'));
    };
  }

  /** Whether a pad or pocket has nothing to build: its first side runs up to what was not imported, with no length recorded. */
  private noDepth(o: FcObject, face: boolean): boolean {
    const type = integer(o, 'Type');
    const sideType = has(o, 'SideType') ? integer(o, 'SideType') : bool(o, 'Midplane') ? 2 : type === 4 ? 1 : 0;
    if (sideType === 2 && type !== 1) return false;
    const t = sideType === 2 || sideType === 1 ? (type === 4 ? 0 : type) : type;
    return t !== 1 && t !== 2 && !(t === 3 && face) && !(float(o, 'Length') > 0);
  }

  /** The extrude a pad or pocket is, or null when a side has no depth to build. */
  private extrudeRow(
    o: FcObject,
    profiles: unknown,
    direction: (reversed: boolean) => Json,
    id?: string,
    op?: Op,
    face?: Json,
  ): Json | null {
    const w = this.w;
    const pad = o.type === 'PartDesign::Pad';
    const type = integer(o, 'Type');
    const sideType = has(o, 'SideType') ? integer(o, 'SideType') : bool(o, 'Midplane') ? 2 : type === 4 ? 1 : 0;
    if (this.noDepth(o, face !== undefined)) {
      this.note(o, 'warning', NO_DEPTH);
      return null;
    }
    const extent = (t: number, length: number, which: string): Json => {
      if (t === 1) return pad ? { upToLast: {} } : { throughAll: {} };
      if (t === 2) return { upToNext: {} };
      if (t === 3 && face && which === '') return { toFace: { face, offset: w.val(mm(float(o, 'Offset'))) } };
      if ((t === 3 || t === 5) && length > 0)
        this.note(
          o,
          'warning',
          `its ${which}extent up to a face or shape was imported as the length FreeCAD recorded, ${numberText(length)} mm`,
        );
      return { distance: { d: which === '' ? this.length(o, 'Length') : this.length(o, 'Length2') } };
    };
    const length = float(o, 'Length');
    const length2 = float(o, 'Length2');
    const side = (e: Json, taper: number): Json => ({ extent: e, taper: w.val(deg(taper)) });
    let sides: Json[];
    if (sideType === 2 && type !== 1)
      sides = [
        {
          extent: { symmetric: { d: this.length(o, 'Length'), measure: w.choice('total') } },
          taper: this.angle(o, 'TaperAngle'),
        },
      ];
    else if (sideType === 2 || sideType === 1) {
      const second = has(o, 'Type2') ? integer(o, 'Type2') : type === 1 ? 1 : 0;
      sides = [
        side(extent(type === 4 ? 0 : type, length, ''), float(o, 'TaperAngle')),
        side(extent(second, length2, 'second side’s '), float(o, 'TaperAngle2')),
      ];
    } else sides = [side(extent(type, length, ''), float(o, 'TaperAngle'))];
    if (float(o, 'Offset') !== 0 && !face) this.note(o, 'warning', 'its offset from the up-to face was not imported');
    // A pad runs along the sketch normal and a pocket against it, each turned round by Reversed.
    const reversed = pad === bool(o, 'Reversed');
    const custom = bool(o, 'UseCustomVector') ? vector(o, 'Direction') : undefined;
    const along = custom
      ? { vector: { v: w.val(vectorText(norm(custom))), reversed: w.flag(pad === bool(o, 'Reversed')) } }
      : direction(reversed);
    // FreeCAD 26.3's start moves the profile along the feature's own direction, as `start` does here.
    const startType = integer(o, 'StartType');
    if (startType === 2) this.note(o, 'warning', 'its start reference was not imported; it starts on the sketch plane');
    const start = startType === 1 ? { start: { offset: { d: this.length(o, 'StartOffset') } } } : {};
    const inputs: Json = {
      profiles,
      sides,
      direction: along,
      thin: { solid: {} },
      operation: w.operation(op ?? this.nextOp(pad)),
      ...start,
    };
    return w.feature('core.extrude', o.label, inputs, this.suppressed(o), id);
  }

  /** A direction or axis a link names, in the Body's frame: an origin axis or plane, or a line of a sketch. */
  private linkAxis(l: FcLink | undefined): { ref?: Json; origin: Vec3; direction: Vec3 } | undefined {
    if (!l) return undefined;
    const role = this.role(l.obj);
    if (role && AXES[role]) {
      const axis = AXES[role];
      return {
        ref: { standard: { name: axis } },
        origin: [0, 0, 0],
        direction: axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1],
      };
    }
    if (role && STANDARD[role]) {
      const f = STANDARD_FRAMES[STANDARD[role]];
      return { origin: [0, 0, 0], direction: rotate(f.rotation, [0, 0, 1]) };
    }
    const s = this.sketches.get(l.obj);
    if (!s) return undefined;
    const sub = l.subs[0] ?? '';
    const p = s.placement;
    if (sub === 'H_Axis' || sub === 'V_Axis')
      return { origin: p.position, direction: rotate(p.rotation, sub === 'H_Axis' ? [1, 0, 0] : [0, 1, 0]) };
    if (sub === 'N_Axis' || sub === '') return { origin: p.position, direction: rotate(p.rotation, [0, 0, 1]) };
    const m = /^(Axis|Edge)(\d+)$/.exec(sub);
    const line = m
      ? (m[1] === 'Axis' ? s.rows.axes : s.rows.edges)[Number(m[2]) - (m[1] === 'Axis' ? 0 : 1)]
      : undefined;
    if (!line) return undefined;
    const [a, b] = [apply(p, [line.start[0], line.start[1], 0]), apply(p, [line.end[0], line.end[1], 0])];
    return {
      ref: this.w.sketchRef(s.feature, 'curve', line.curve),
      origin: a,
      direction: norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]),
    };
  }

  private revolve(o: FcObject): void {
    const s = this.profile(o);
    if (!s) return;
    const w = this.w;
    const additive = o.type === 'PartDesign::Revolution';
    // FreeCAD keeps the solved axis on the feature, whatever it was picked from.
    const base = vector(o, 'Base') ?? [0, 0, 0];
    const stored = norm(vector(o, 'Axis') ?? [0, 0, 1]);
    const picked = this.linkAxis(link(o, 'ReferenceAxis'));
    const flip = bool(o, 'Reversed');
    let axis: Json;
    // The reference stands for the axis only when it is the same line: FreeCAD can project it onto the profile's plane, and stores where it went.
    const between: Vec3 | undefined = picked && [
      base[0] - picked.origin[0],
      base[1] - picked.origin[1],
      base[2] - picked.origin[2],
    ];
    const off = between
      ? Math.hypot(...scale(stored, dot(between, stored)).map((v, i) => v - (between[i] as number)))
      : Infinity;
    if (picked?.ref && Math.abs(Math.abs(dot(picked.direction, stored)) - 1) < 1e-9 && off < 1e-6) {
      axis = { along: { ref: picked.ref, reversed: w.flag(dot(picked.direction, stored) < 0 !== flip) } };
    } else {
      axis = {
        through: {
          point: { at: { v: w.val(vectorText(base)) } },
          direction: { vector: { v: w.val(vectorText(stored)), reversed: w.flag(flip) } },
        },
      };
    }
    const type = integer(o, 'Type');
    const angle = float(o, 'Angle');
    // Files from before FreeCAD 26.3 say two sides by `Type` 4 and symmetric by `Midplane`; later ones by `SideType`, with `Type2` for the second side.
    const sideType = integer(o, 'SideType');
    const twoSides = type === 4 || sideType === 1;
    const symmetric = bool(o, 'Midplane') || sideType === 2;
    const startType = integer(o, 'StartType');
    if (startType !== 0) {
      this.note(
        o,
        'warning',
        startType === 1
          ? `its start of ${numberText(float(o, 'StartOffset'))}° was not imported; it revolves from the sketch plane`
          : 'its start reference was not imported; it revolves from the sketch plane',
      );
    }
    let sides: Json[];
    if (twoSides) {
      const type2 = integer(o, 'Type2');
      const angle2 = float(o, 'Angle2');
      const angular = (t: number) => t === 0 || t === 4;
      if (!additive && (type === 1 || type2 === 1)) sides = [{ full: {} }];
      else if (!angular(type) || !angular(type2)) {
        this.note(o, 'warning', 'a side up to a face has no equivalent here, so it was left out');
        return;
      } else if (angle + angle2 >= 360) sides = [{ full: {} }];
      else if (angle < 0 || angle2 < 0 || angle + angle2 <= 0) {
        this.note(o, 'warning', 'angles on the same side of the sketch have no equivalent here, so it was left out');
        return;
      } else sides = [{ angle: { a: this.angle(o, 'Angle') } }, { angle: { a: this.angle(o, 'Angle2') } }];
    } else if ((type === 1 && !additive) || angle >= 360) sides = [{ full: {} }];
    else if (symmetric) sides = [{ symmetric: { a: this.angle(o, 'Angle'), measure: w.choice('total') } }];
    else {
      if (type !== 0)
        this.note(
          o,
          'warning',
          `its extent up to a face was imported as the angle FreeCAD recorded, ${numberText(angle)}°`,
        );
      sides = [{ angle: { a: this.angle(o, 'Angle') } }];
    }
    const inputs: Json = {
      profiles: this.profiles(s),
      axis,
      sides,
      thin: { solid: {} },
      operation: w.operation(this.nextOp(additive)),
    };
    this.add(o, w.feature('core.revolve', o.label, inputs, this.suppressed(o)));
  }

  private hole(o: FcObject): void {
    const w = this.w;
    const l = link(o, 'Profile');
    const s = l && this.sketches.get(l.obj);
    if (!s || s.rows.circleCenters.length === 0) {
      this.note(o, 'warning', 'its sketch has no circles here, so it was left out');
      return;
    }
    const diameter = float(o, 'Diameter');
    const cut = enumeration(o, 'HoleCutType');
    const cutName = (
      cut.name ??
      ['None', 'Counterbore', 'Countersink', 'Counterdrill'][cut.index] ??
      'None'
    ).toLowerCase();
    const kind =
      cutName === 'none'
        ? 'simple'
        : cutName.includes('sink') || cutName.includes('drill')
          ? 'countersink'
          : 'counterbore';
    const angled = integer(o, 'DrillPoint') === 1;
    const tipAngle = float(o, 'DrillPointAngle', 118);
    const through = integer(o, 'DepthType') === 1;
    if (angled && !through && !(tipAngle > 0 && tipAngle < 180)) {
      this.note(o, 'warning', 'its drill point angle is not between 0 and 180 degrees, so it was left out');
      return;
    }
    let depth = float(o, 'Depth');
    if (angled && bool(o, 'DrillForDepth')) depth -= diameter / 2 / Math.tan((tipAngle * Math.PI) / 360);
    if (integer(o, 'DepthType') > 1)
      this.note(
        o,
        'warning',
        `its depth up to a face was imported as the depth FreeCAD recorded, ${numberText(depth)} mm`,
      );
    const threadType = enumeration(o, 'ThreadType');
    const size = enumeration(o, 'ThreadSize').name;
    const metric = threadType.index === 1 || threadType.index === 2 || /ISO/i.test(threadType.name ?? '');
    let thread: Json = { none: {} };
    if (bool(o, 'Threaded')) {
      if (metric && size && /^M[\d.]+(x[\d.]+)?$/.test(size)) {
        const threadClass = enumeration(o, 'ThreadClass');
        const cls = threadClass.name ?? THREAD_CLASSES[threadClass.index] ?? '6H';
        const modelled = bool(o, 'ModelThread');
        const left = integer(o, 'ThreadDirection') === 1;
        thread = {
          thread: {
            standard: w.val('"ISO metric"'),
            designation: w.val(JSON.stringify(size)),
            class: w.val(JSON.stringify(cls)),
            modelled: w.flag(modelled),
            ...(left ? { hand: w.val('"left"') } : {}),
          },
        };
        if (modelled && integer(o, 'ThreadDepthType') !== 0)
          this.note(o, 'warning', 'its thread depth was not imported; the thread runs the whole bore');
      } else
        this.note(o, 'warning', 'its thread is not an ISO metric one; the hole was drilled at its diameter without it');
    }
    if (bool(o, 'Tapered')) this.note(o, 'warning', 'its taper was not imported');
    // The hole runs down the sketch's z, into the material; Reversed drills the other way, in the frame turned over its x axis, whose y is the sketch's -y.
    const flip = bool(o, 'Reversed');
    const inputs: Json = {
      placement: { frame: s.frame(flip) },
      positions: s.rows.circleCenters.map((c) => ({
        id: w.ids('hp'),
        at: { at: { v: w.val(`vector(${mm(c.at[0])}, ${mm(flip ? -c.at[1] : c.at[1])}, 0 mm)`) } },
      })),
      kind: w.choice(kind),
      diameter: this.parameters.value(o, 'Diameter', mm(diameter), diameter, 'length', this.scope),
      depth: through
        ? { throughAll: {} }
        : { distance: { d: bool(o, 'DrillForDepth') ? w.val(mm(depth)) : this.length(o, 'Depth') } },
      tip: angled && !through ? { angle: { a: w.val(deg(tipAngle)) } } : { flat: {} },
      ...(kind === 'counterbore'
        ? {
            counterbore: {
              diameter: w.val(mm(float(o, 'HoleCutDiameter'))),
              depth: w.val(mm(float(o, 'HoleCutDepth'))),
            },
          }
        : {}),
      ...(kind === 'countersink'
        ? {
            countersink: {
              diameter: w.val(mm(float(o, 'HoleCutDiameter'))),
              angle: w.val(deg(float(o, 'HoleCutCountersinkAngle', 90))),
            },
          }
        : {}),
      thread,
    };
    this.add(o, w.feature('core.hole', o.label, inputs, this.suppressed(o)));
  }

  /** The features a pattern or mirror copies, or undefined when one of them was not imported. */
  private originals(o: FcObject): Json | undefined {
    const names = links(o, 'Originals').map((l) => l.obj);
    const ids = names.map((n) => this.features.get(n));
    if (names.length === 0 || ids.some((id) => id === undefined)) {
      this.note(o, 'warning', 'what it copies was not imported, so it was left out');
      return undefined;
    }
    if (enumeration(o, 'TransformMode').index !== 0) {
      this.note(o, 'warning', 'it copies the whole body, which is not imported');
      return undefined;
    }
    return { features: makeSet(ids.map((id) => ({ object: { feature: { id } } }))) };
  }

  private direction(a: { ref?: Json; direction: Vec3 }, reversed: boolean): Json {
    const w = this.w;
    const standard = a.ref && 'standard' in a.ref ? ((a.ref.standard as Json).name as string) : undefined;
    if (standard) return { axis: { axis: w.choice(standard), reversed: w.flag(reversed) } };
    return { vector: { v: w.val(vectorText(a.direction)), reversed: w.flag(reversed) } };
  }

  private pattern(o: FcObject): void {
    if (this.wholeBody(o)) {
      const layout = this.layout(o);
      if (layout)
        this.copyBody(o, (of, id, op) =>
          this.w.feature(
            'core.pattern',
            o.label,
            { of, layout, skip: makeSet([]), vary: [], operation: op },
            this.suppressed(o),
            id,
          ),
        );
      return;
    }
    const of = this.originals(o);
    if (!of) return;
    const layout = this.layout(o);
    if (!layout) return;
    const inputs: Json = { of, layout, skip: makeSet([]), vary: [], operation: this.w.operation('join') };
    this.add(o, this.w.feature('core.pattern', o.label, inputs, this.suppressed(o)));
  }

  /** Whether a transform copies everything before it, not named features. */
  private wholeBody(o: FcObject): boolean {
    return enumeration(o, 'TransformMode').index === 1 && has(o, 'TransformMode');
  }

  /** A pattern or mirror of the whole body: it names the bodies live before it. */
  private copyBody(o: FcObject, row: (of: Json, id: string, operation: Json) => Json): void {
    const bytes = this.stored(o.name);
    if (!bytes) return;
    const id = this.w.ids('feat');
    const operation = this.w.operation('join');
    this.defer(o, {
      kind: 'locate',
      part: this.part.id,
      before: undefined,
      object: o.label,
      id,
      shape: new TextDecoder().decode(bytes),
      entity: 'face',
      indices: [],
      needsBodies: true,
      row: (_, bodies) => row({ bodies: makeSet(bodies) }, id, operation),
    });
  }

  /** The layout of a linear or polar pattern. */
  private layout(o: FcObject): Json | undefined {
    const w = this.w;
    const count = integer(o, 'Occurrences', 1);
    let layout: Json;
    if (o.type === 'PartDesign::LinearPattern') {
      const row = (
        dirProp: string,
        occProp: string,
        lengthProp: string,
        offsetProp: string,
        modeProp: string,
        revProp: string,
      ): Json | undefined => {
        const n = integer(o, occProp, 1);
        const axis = this.linkAxis(link(o, dirProp));
        if (!axis) return undefined;
        const byOffset = enumeration(o, modeProp).index === 1;
        const step = byOffset ? float(o, offsetProp) : n > 1 ? float(o, lengthProp) / (n - 1) : 0;
        return {
          direction: this.direction(axis, bool(o, revProp)),
          count: w.val(String(n)),
          spacing: { equal: { s: byOffset ? this.length(o, offsetProp) : w.val(mm(step)) } },
        };
      };
      const first = row('Direction', 'Occurrences', 'Length', 'Offset', 'Mode', 'Reversed');
      if (!first) {
        this.note(o, 'info', 'its direction is not an origin axis or a sketch line');
        return undefined;
      }
      const second =
        integer(o, 'Occurrences2', 1) > 1
          ? row('Direction2', 'Occurrences2', 'Length2', 'Offset2', 'Mode2', 'Reversed2')
          : undefined;
      layout = { linear: { directions: second ? [first, second] : [first] } };
    } else {
      const axis = this.linkAxis(link(o, 'Axis'));
      if (!axis) {
        this.note(o, 'info', 'its axis is not an origin axis or a sketch line');
        return undefined;
      }
      const reversed = bool(o, 'Reversed');
      const spacing = enumeration(o, 'Mode').index === 1;
      const angle = spacing
        ? Math.abs(float(o, 'Offset') * count - 360) < 1e-9
          ? 360
          : float(o, 'Offset') * (count - 1)
        : float(o, 'Angle', 360);
      const along = axis.ref
        ? { along: { ref: axis.ref, reversed: w.flag(reversed) } }
        : {
            through: {
              point: { at: { v: w.val(vectorText(axis.origin)) } },
              direction: { vector: { v: w.val(vectorText(axis.direction)), reversed: w.flag(reversed) } },
            },
          };
      layout = {
        circular: { axis: along, count: w.val(String(count)), angle: w.val(deg(angle)), symmetric: w.flag(false) },
      };
    }
    return layout;
  }

  private mirror(o: FcObject): void {
    if (this.wholeBody(o)) {
      const whole = this.mirrorPlane(o);
      if (whole)
        this.copyBody(o, (of, id, operation) =>
          this.w.feature('core.mirror', o.label, { of, plane: whole, operation }, this.suppressed(o), id),
        );
      return;
    }
    const of = this.originals(o);
    if (!of) return;
    const plane = this.mirrorPlane(o);
    if (!plane) return;
    const inputs: Json = { of, plane, operation: this.w.operation('join') };
    this.add(o, this.w.feature('core.mirror', o.label, inputs, this.suppressed(o)));
  }

  /** A MultiTransform: its transformations in order, as one chain. */
  private multiTransform(o: FcObject): void {
    const of = this.originals(o);
    if (!of) return;
    const steps: Json[] = [];
    for (const l of links(o, 'Transformations')) {
      const t = this.doc.byName.get(l.obj);
      const step = !t
        ? undefined
        : t.type === 'PartDesign::Mirrored'
          ? this.mirrorPlane(t)
          : t.type === 'PartDesign::Scaled'
            ? undefined
            : this.layout(t);
      if (!t || !step) {
        this.note(o, 'info', 'one of its transformations has no equivalent here');
        return;
      }
      steps.push({
        id: this.w.ids('stp'),
        step: t.type === 'PartDesign::Mirrored' ? { mirror: { plane: step } } : step,
      });
    }
    if (steps.length === 0) return;
    this.add(o, this.w.feature('core.transformChain', o.label, { of, steps }, this.suppressed(o)));
  }

  /** The plane a Mirrored names, when it is a standard plane or a sketch axis through one. */
  private mirrorPlane(o: FcObject): Json | undefined {
    const l = link(o, 'MirrorPlane');
    const role = l && l.subs.length === 0 ? this.role(l.obj) : undefined;
    const sketch = l && this.sketches.get(l.obj);
    let plane: string | undefined = role ? STANDARD[role] : undefined;
    if (!plane && sketch) {
      // A sketch axis mirrors in the plane through it square to the sketch: the same as a standard plane when the sketch lies on one.
      const sub = l?.subs[0] ?? 'V_Axis';
      const normal = rotate(
        sketch.placement.rotation,
        sub === 'H_Axis' ? [0, 1, 0] : sub === 'V_Axis' ? [1, 0, 0] : [0, 0, 1],
      );
      const throughOrigin = Math.abs(dot(sketch.placement.position, normal)) < 1e-9;
      for (const [name, f] of Object.entries(STANDARD_FRAMES)) {
        if (throughOrigin && Math.abs(Math.abs(dot(rotate(f.rotation, [0, 0, 1]), normal)) - 1) < 1e-9) plane = name;
      }
    }
    if (plane) return { standard: { name: plane } };
    const datum = l && this.doc.byName.get(l.obj);
    const id = datum?.type === 'PartDesign::Plane' ? this.features.get(datum.name) : undefined;
    if (id) return { object: { feature: { id } } };
    this.note(o, 'info', 'its mirror plane is not an origin plane or a datum plane');
    return undefined;
  }

  private datum(o: FcObject): void {
    const type =
      {
        'PartDesign::Plane': 'core.constructionPlane',
        'PartDesign::Line': 'core.constructionAxis',
        'PartDesign::Point': 'core.constructionPoint',
      }[o.type] ?? 'core.constructionFrame';
    this.add(
      o,
      this.w.feature(
        type,
        o.label,
        { frame: { fixed: { placement: this.w.placement(placement(o)) } } },
        this.suppressed(o),
      ),
    );
  }

  private dressUp(o: FcObject): void {
    const base = link(o, 'Base');
    const fillet = o.type === 'PartDesign::Fillet';
    const bytes = base ? this.stored(base.obj) : undefined;
    if (!base || !this.features.has(base.obj) || !bytes) {
      this.note(
        o,
        'warning',
        !base || this.features.has(base.obj)
          ? 'the file does not hold the shape it rounds, so it was left out'
          : 'the feature it rounds was not imported, so it was left out',
      );
      return;
    }
    const all = bool(o, 'UseAllEdges');
    const edges = all ? [] : base.subs.flatMap((s) => (/^Edge\d+$/.test(s) ? [Number(s.slice(4)) - 1] : []));
    // A face stands for its edges.
    const faces = all ? [] : base.subs.flatMap((s) => (/^Face\d+$/.test(s) ? [Number(s.slice(4)) - 1] : []));
    if (!all && edges.length === 0 && faces.length === 0) {
      this.note(o, 'warning', 'it names no edges, so it was left out');
      return;
    }
    const w = this.w;
    const label = o.label;
    const suppressed = this.suppressed(o);
    const sized = (): Json => {
      const type = integer(o, 'ChamferType');
      if (type === 1) return { twoDistances: { d1: this.length(o, 'Size'), d2: this.length(o, 'Size2') } };
      if (type === 2) return { distanceAngle: { d: this.length(o, 'Size'), angle: this.angle(o, 'Angle') } };
      return { distance: { d: this.length(o, 'Size') } };
    };
    // Written now: `complete` builds the row after the expressions are settled.
    const radius = fillet ? this.length(o, 'Radius') : undefined;
    const size = fillet ? undefined : sized();
    const id = w.ids('feat');
    this.defer(o, {
      kind: 'locate',
      part: this.part.id,
      before: undefined,
      object: label,
      id,
      shape: new TextDecoder().decode(bytes),
      entity: 'edge',
      indices: all ? 'all' : edges,
      ofFaces: faces,
      row: (targets) =>
        fillet
          ? w.feature(
              'core.fillet',
              label,
              { sets: [{ targets: makeSet(targets), radius: { constant: { s: radius } }, setback: w.val('0 mm') }] },
              suppressed,
              id,
            )
          : w.feature('core.chamfer', label, { sets: [{ targets: makeSet(targets), size }] }, suppressed, id),
    });
    const check = this.checks.find((c) => c.feature === id);
    if (check && !fillet && integer(o, 'ChamferType') === 1) {
      check.alternative = (row) => {
        for (const set of (row.inputs as Json).sets as Json[]) {
          const two = (set.size as Json).twoDistances as Json;
          [two.d1, two.d2] = [two.d2, two.d1];
        }
      };
    }
  }

  /** The sketch a link names, with the one region a section of a loft is. */
  private section(l: FcLink): Json | undefined {
    const s = this.sketches.get(l.obj);
    if (!s || s.rows.faces.length !== 1) return undefined;
    return { id: this.w.ids('sec'), section: { profiles: this.profiles(s) } };
  }

  private loft(o: FcObject): void {
    const w = this.w;
    const first = link(o, 'Profile') ?? link(o, 'Sketch');
    const rest = links(o, 'Sections');
    const rows = (first ? [first, ...rest] : rest).map((l) => this.section(l));
    if (rows.length < 2 || rows.some((r) => r === undefined)) {
      this.note(o, 'info', 'its sections are not each one region of a sketch');
      return;
    }
    const additive = o.type === 'PartDesign::AdditiveLoft';
    const inputs: Json = {
      sections: rows,
      rails: [],
      ruled: w.flag(bool(o, 'Ruled')),
      closed: w.flag(bool(o, 'Closed')),
      operation: w.operation(this.nextOp(additive)),
    };
    this.add(o, w.feature('core.loft', o.label, inputs, this.suppressed(o)));
  }

  private pipe(o: FcObject): void {
    const w = this.w;
    const s = this.profile(o);
    if (!s) return;
    const mode = integer(o, 'Mode');
    if (links(o, 'Sections').length > 0 || integer(o, 'Transformation') !== 0 || mode === 3 || mode === 4) {
      this.note(o, 'info', 'it runs through several sections, or along a second path');
      return;
    }
    const additive = o.type === 'PartDesign::AdditivePipe';
    const spine = link(o, 'Spine');
    const path = spine && this.sketches.get(spine.obj);
    if (!spine) return;
    const sections = [{ id: w.ids('sec'), section: { profiles: this.profiles(s) } }];
    const row = (chain: Json[], id?: string, op: Op = this.nextOp(additive)): Json =>
      w.feature(
        'core.sweep',
        o.label,
        {
          sections,
          path: chain,
          orientation: mode === 1 ? { fixed: {} } : { followPath: {} },
          operation: w.operation(op),
        },
        this.suppressed(o),
        id,
      );
    if (path) {
      const named = spine.subs.flatMap((sub) => {
        const m = /^Edge(\d+)$/.exec(sub);
        const e = m ? path.rows.edges[Number(m[1]) - 1] : undefined;
        return e ? [e.curve] : [];
      });
      const curves = named.length > 0 ? named : path.rows.edges.map((e) => e.curve);
      if (curves.length === 0) return;
      this.add(o, row(curves.map((c) => w.sketchRef(path.feature, 'curve', c))));
      return;
    }
    const edges = spine.subs.flatMap((sub) => (/^Edge\d+$/.test(sub) ? [Number(sub.slice(4)) - 1] : []));
    const bytes = this.stored(spine.obj);
    if (!this.features.has(spine.obj) || !bytes || edges.length === 0) return;
    const id = w.ids('feat');
    const op = this.nextOp(additive);
    this.defer(o, {
      kind: 'locate',
      part: this.part.id,
      before: undefined,
      object: o.label,
      id,
      shape: new TextDecoder().decode(bytes),
      entity: 'edge',
      indices: edges,
      row: (refs) => row(refs, id, op),
    });
  }

  /**
   * A Body fused with, cut by or met with another: a part here reads another's
   * bodies by a derive, which joins them itself; for the rest a boolean follows
   * it. It waits for `complete`, as the other Body may convert later. Several
   * Bodies at once stay the shape FreeCAD stored.
   */
  private boolean(o: FcObject): void {
    const w = this.w;
    const named = links(o, 'Group').length > 0 ? links(o, 'Group') : links(o, 'Bodies');
    const tool = named.length === 1 ? this.doc.byName.get((named[0] as FcLink).obj) : undefined;
    const op = (['join', 'cut', 'intersect'] as const)[integer(o, 'Type')];
    if (tool?.type !== 'PartDesign::Body' || !op) return;
    const body = this.doc.objects.find(
      (b) => b.type === 'PartDesign::Body' && links(b, 'Group').some((l) => l.obj === o.name),
    );
    const frame = {
      fixed: { placement: w.placement(compose(invert(body ? placement(body) : IDENTITY), placement(tool))) },
    };
    const instance = w.ids('inst');
    const step = {
      kind: 'locate',
      part: this.part.id,
      before: undefined,
      object: o.label,
      shape: '',
      entity: 'face',
      indices: [],
    } as const;
    const derive = (id: string, operation: 'new' | 'join') =>
      w.feature(
        'core.derive',
        o.label,
        {
          from: { part: { id: this.partOfBody.get(tool.name) as string } },
          instance,
          items: { all: {} },
          overrides: [],
          frame,
          operation: w.operation(operation),
        },
        this.suppressed(o),
        id,
      );
    const id = w.ids('feat');
    if (op === 'join') {
      this.defer(o, { ...step, indices: [], id, row: () => derive(id, 'join') });
      return;
    }
    const bring = w.ids('feat');
    const first: Step = {
      ...step,
      indices: [],
      id: bring,
      row: () => derive(bring, 'new'),
      ...(this.afterTip ? { pastTip: true } : {}),
    };
    this.steps.push(first);
    this.pending.push(first);
    this.defer(o, {
      ...step,
      indices: [],
      id,
      needsBodies: true,
      row: (_, bodies) =>
        w.feature(
          'core.boolean',
          o.label,
          { target: bodies[0], tools: makeSet(bodies.slice(1)), op: w.choice(op), keepTools: w.flag(false) },
          this.suppressed(o),
          id,
        ),
    });
  }

  /** A plane a link names, as a reference: an origin plane or a datum plane. */
  private planeRef(l: FcLink | undefined): Json | undefined {
    if (!l || l.subs.some((s) => s.length > 0)) return undefined;
    const role = this.role(l.obj);
    const standard = role ? STANDARD[role] : undefined;
    if (standard) return { standard: { name: standard } };
    const id = this.doc.byName.get(l.obj)?.type === 'PartDesign::Plane' ? this.features.get(l.obj) : undefined;
    return id ? { object: { feature: { id } } } : undefined;
  }

  /** PartDesign's Draft: faces tilted about a neutral plane, pulled along its normal unless a line is named. */
  private draft(o: FcObject): void {
    const w = this.w;
    const base = link(o, 'Base');
    const bytes = base ? this.stored(base.obj) : undefined;
    const faces = (base?.subs ?? []).flatMap((s) => (/^Face\d+$/.test(s) ? [Number(s.slice(4)) - 1] : []));
    if (!base || !bytes || !this.features.has(base.obj) || faces.length === 0) return;
    const neutralLink = link(o, 'NeutralPlane');
    const neutralFace =
      neutralLink && neutralLink.obj === base.obj ? /^Face(\d+)$/.exec(neutralLink.subs[0] ?? '') : null;
    const standing = this.planeRef(neutralLink);
    if (!neutralFace && !standing) return;
    const pullLink = link(o, 'PullDirection');
    const pull = pullLink ? this.linkAxis(pullLink) : undefined;
    if (pullLink && !pull) return;
    const reversed = bool(o, 'Reversed');
    const angle = float(o, 'Angle') * (reversed ? -1 : 1);
    const id = w.ids('feat');
    const indices = neutralFace ? [...faces, Number(neutralFace[1]) - 1] : faces;
    this.defer(o, {
      kind: 'locate',
      part: this.part.id,
      before: undefined,
      object: o.label,
      id,
      shape: new TextDecoder().decode(bytes),
      entity: 'face',
      indices,
      row: (refs) => {
        const drafted = neutralFace ? refs.slice(0, -1) : refs;
        const neutral = neutralFace ? (refs[refs.length - 1] as Json) : (standing as Json);
        const direction = pull
          ? this.direction(pull, reversed)
          : { normal: { ref: structuredClone(neutral), reversed: w.flag(reversed) } };
        return w.feature(
          'core.draft',
          o.label,
          { faces: makeSet(drafted), neutral, pull: direction, angle: w.val(deg(angle)) },
          this.suppressed(o),
          id,
        );
      },
    });
  }

  /** PartDesign's helix: the profile swept along a helix about an axis. */
  private helix(o: FcObject): void {
    const w = this.w;
    const s = this.profile(o);
    if (!s) return;
    if (float(o, 'Angle') !== 0 || float(o, 'Growth') !== 0) {
      this.note(o, 'info', 'a tapered or growing helix has no equivalent here');
      return;
    }
    const base = vector(o, 'Base') ?? [0, 0, 0];
    const stored = norm(vector(o, 'Axis') ?? [0, 0, 1]);
    const axisDirection = bool(o, 'Reversed') ? scale(stored, -1) : stored;
    const additive = o.type === 'PartDesign::AdditiveHelix';
    const axis = {
      through: {
        point: { at: { v: w.val(vectorText(base)) } },
        direction: { vector: { v: w.val(vectorText(axisDirection)), reversed: w.flag(false) } },
      },
    };
    const inputs: Json = {
      axis,
      advance: { pitch: { p: w.val(mm(float(o, 'Pitch'))) } },
      height: w.val(mm(float(o, 'Height'))),
      handedness: w.choice(bool(o, 'LeftHanded') ? 'left' : 'right'),
      section: { profiles: this.profiles(s) },
      operation: w.operation(this.nextOp(additive)),
    };
    this.add(o, w.feature('core.coil', o.label, inputs, this.suppressed(o)));
  }

  /** PartDesign's Thickness: the body hollowed through the faces it names. */
  private thickness(o: FcObject): void {
    const w = this.w;
    const base = link(o, 'Base');
    const bytes = base ? this.stored(base.obj) : undefined;
    const faces = (base?.subs ?? []).flatMap((s) => (/^Face\d+$/.test(s) ? [Number(s.slice(4)) - 1] : []));
    if (!base || !bytes || !this.features.has(base.obj) || faces.length === 0 || integer(o, 'Mode') !== 0) return;
    const id = w.ids('feat');
    const value = float(o, 'Value');
    const direction = bool(o, 'Reversed') ? 'inside' : 'outside';
    this.defer(o, {
      kind: 'locate',
      part: this.part.id,
      before: undefined,
      object: o.label,
      id,
      shape: new TextDecoder().decode(bytes),
      entity: 'face',
      indices: faces,
      needsBodies: true,
      row: (refs, bodies) =>
        w.feature(
          'core.shell',
          o.label,
          {
            bodies: makeSet(bodies),
            remove: makeSet(refs),
            thickness: w.val(mm(value)),
            direction: w.choice(direction),
          },
          this.suppressed(o),
          id,
        ),
    });
  }

  /** A shape FreeCAD stored, as `core.import` keeping no file, made by `complete`. */
  shape(o: FcObject, version: string): boolean {
    const bytes = this.stored(o.name);
    if (!bytes) return false;
    const w = this.w;
    const id = w.ids('feat');
    this.defer(o, {
      kind: 'shape',
      part: this.part.id,
      before: undefined,
      object: o.label,
      id,
      brep: bytes,
      name: `${o.label}.brp`,
      row: (stored) =>
        w.feature(
          'core.import',
          o.label,
          {
            source: { kept: {} },
            stored,
            importer: { format: 'FreeCAD', version },
            units: w.choice('mm'),
            upAxis: w.choice('y'),
          },
          this.suppressed(o),
          id,
        ),
    });
    return true;
  }

  /** A Body's base feature: the solid it starts from, as FreeCAD stored it. */
  private base(o: FcObject): void {
    if (!link(o, 'BaseFeature')) return;
    if (!this.shape(o, this.doc.programVersion ?? ''))
      this.note(o, 'warning', 'the file does not hold its shape, so it was left out');
  }

  /** A sketch row of its own for a primitive built from one, at `at`, with `rows` drawn on it. */
  private ownSketch(o: FcObject, at: FcPlacement, rows: { inputs: Json; region: string }): unknown {
    const w = this.w;
    const row = w.feature('core.sketch', `${o.label} profile`, {
      frame: { fixed: { placement: w.placement(at) } },
      ...rows.inputs,
    });
    this.part.timeline.push(row);
    for (const s of this.pending) s.before = row.id as string;
    this.pending = [];
    return makeSet([w.sketchRef(row.id as string, 'region', rows.region)]);
  }

  /**
   * A cylinder, cone, sphere or torus of less than a full turn: its half
   * section in the plane through the axis, turned by the angle FreeCAD holds
   * from its x axis. True when `o` was one: written, or, when its section
   * encloses nothing, left to the shape FreeCAD stored.
   */
  private partialPrimitive(o: FcObject, kind: string, at: FcPlacement, additive: boolean): boolean {
    const w = this.w;
    const turn = kind === 'Sphere' || kind === 'Torus' ? float(o, 'Angle3', 360) : float(o, 'Angle', 360);
    let rows: { inputs: Json; region: string } | undefined;
    const h = float(o, 'Height');
    if (kind === 'Cylinder' || kind === 'Cone') {
      if (turn >= 360) return false;
      if (float(o, 'FirstAngle') !== 0 || float(o, 'SecondAngle') !== 0) return false;
      const [r1, r2] =
        kind === 'Cone' ? [float(o, 'Radius1'), float(o, 'Radius2')] : [float(o, 'Radius'), float(o, 'Radius')];
      rows = outlineRows(w, [0, 0], [{ to: [r1, 0] }, { to: [r2, h] }, { to: [0, h] }, { to: [0, 0] }]);
    } else if (kind === 'Sphere') {
      const [a1, a2] = [float(o, 'Angle1', -90), float(o, 'Angle2', 90)];
      if (turn >= 360 && a1 <= -90 && a2 >= 90) return false;
      const r = float(o, 'Radius');
      const lat = (d: number): [number, number] => [
        r * Math.cos((d * Math.PI) / 180),
        r * Math.sin((d * Math.PI) / 180),
      ];
      const [p1, p2] = [lat(a1), lat(a2)];
      const steps: OutlineStep[] = [{ to: p1 }, { to: p2, center: [0, 0] }, { to: [0, p2[1]] }, { to: [0, p1[1]] }];
      rows = outlineRows(w, [0, p1[1]], steps);
    } else if (kind === 'Torus') {
      if (turn >= 360) return false;
      if (float(o, 'Angle1', -180) > -180 || float(o, 'Angle2', 180) < 180) return false;
      rows = circleRows(w, [float(o, 'Radius1'), 0], float(o, 'Radius2'));
    } else return false;
    if (!rows) return true;
    // The section lies in the primitive's xz plane: sketch x along its x, sketch y along its z.
    const frame = compose(at, placementOfFrame([0, 0, 0], [1, 0, 0], [0, -1, 0]));
    const profiles = this.ownSketch(o, frame, rows);
    const axis = {
      through: {
        point: { at: { v: w.val(vectorText(at.position)) } },
        direction: { vector: { v: w.val(vectorText(rotate(at.rotation, [0, 0, 1]))), reversed: w.flag(false) } },
      },
    };
    const sides = turn >= 360 ? [{ full: {} }] : [{ angle: { a: w.val(deg(turn)) } }];
    const inputs: Json = { profiles, axis, sides, thin: { solid: {} }, operation: w.operation(this.nextOp(additive)) };
    this.add(o, w.feature('core.revolve', o.label, inputs, this.suppressed(o)));
    return true;
  }

  /** PartDesign's prism: a regular polygon extruded along its z. */
  private prism(o: FcObject): void {
    const w = this.w;
    if (float(o, 'FirstAngle') !== 0 || float(o, 'SecondAngle') !== 0) return;
    const sides = integer(o, 'Polygon');
    const r = float(o, 'Circumradius');
    if (sides < 3 || sides > PRISM_SIDES || !(r > 0)) return;
    const corner = (i: number): [number, number] => [
      r * Math.cos((2 * Math.PI * i) / sides),
      r * Math.sin((2 * Math.PI * i) / sides),
    ];
    const steps = Array.from({ length: sides }, (_, i) => ({ to: corner(i + 1) }));
    const rows = outlineRows(w, corner(0), steps);
    if (!rows) return;
    const profiles = this.ownSketch(o, placement(o), rows);
    const additive = o.type === 'PartDesign::AdditivePrism';
    const at = placement(o);
    const inputs: Json = {
      profiles,
      sides: [{ extent: { distance: { d: w.val(mm(float(o, 'Height'))) } }, taper: w.val(deg(0)) }],
      direction: { vector: { v: w.val(vectorText(rotate(at.rotation, [0, 0, 1]))), reversed: w.flag(false) } },
      thin: { solid: {} },
      operation: w.operation(this.nextOp(additive)),
    };
    this.add(o, w.feature('core.extrude', o.label, inputs, this.suppressed(o)));
  }

  /** PartDesign's primitives: placed by their stored placement, centred as a primitive here is (appendix A). */
  private primitive(o: FcObject): void {
    const w = this.w;
    const additive = o.type.includes('Additive');
    const kind = o.type.replace(/^PartDesign::(Additive|Subtractive)/, '');
    const at = placement(o);
    const len = (name: string) => this.length(o, name);
    let shape: Json;
    let lift: Vec3 = [0, 0, 0];
    switch (kind) {
      case 'Box':
        shape = { box: { width: len('Length'), height: len('Height'), depth: len('Width') } };
        lift = [float(o, 'Length') / 2, float(o, 'Width') / 2, float(o, 'Height') / 2];
        break;
      case 'Cylinder':
        shape = { cylinder: { radius: len('Radius'), height: len('Height') } };
        lift = [0, 0, float(o, 'Height') / 2];
        break;
      case 'Sphere':
        shape = { sphere: { radius: len('Radius') } };
        break;
      case 'Cone':
        shape = { cone: { bottomRadius: len('Radius1'), topRadius: len('Radius2'), height: len('Height') } };
        lift = [0, 0, float(o, 'Height') / 2];
        break;
      default:
        shape = { torus: { majorRadius: len('Radius1'), minorRadius: len('Radius2') } };
    }
    if (this.partialPrimitive(o, kind, at, additive)) return;
    const frame = { fixed: { placement: w.placement(compose(at, { position: lift, rotation: [0, 0, 0, 1] })) } };
    this.add(
      o,
      w.feature(
        'core.primitive',
        o.label,
        { shape, frame, operation: w.operation(this.nextOp(additive)) },
        this.suppressed(o),
      ),
    );
  }
}

/** How much of the shapes FreeCAD stored, in megabytes, the Part workbench's results bring in. */
const SHOWN_SHAPES_MB = 8;

/** The most sides a prism is drawn with here; one with more comes in as the shape FreeCAD stored. */
const PRISM_SIDES = 1000;

const NO_DEPTH = 'what it extrudes up to was not imported and it records no length, so it was left out';

const NOT_BUILT_FROM = new Set(['ExpressionEngine', 'Group', 'Hosts']);

/** Converts a parsed FreeCAD document. Bodies that hold nothing are left out. */
export function convertDocument(doc: FcDocument, o: ConvertOptions): Conversion {
  const w = new Writer(o.ids);
  const notes: ImportNote[] = [];
  const steps: Step[] = [];
  const checks: Check[] = [];
  const parameters = new Parameters(w, doc);
  notes.push(...parameters.notes);
  const appearances = readAppearances(o.files ?? new Map());
  const styles: BodyStyle[] = [];
  const bodies = doc.objects.filter((x) => x.type === 'PartDesign::Body');
  const files = o.files ?? new Map<string, Uint8Array>();
  const placed: { part: string; placement: FcPlacement }[] = [];
  const membersOf = (body: FcObject): FcObject[] => {
    const listed = (links(body, 'Group').length > 0 ? links(body, 'Group') : links(body, 'Model'))
      .map((l) => doc.byName.get(l.obj))
      .filter((x): x is FcObject => x !== undefined);
    const tip = doc.byName.get(link(body, 'Tip')?.obj ?? '');
    if (!tip || listed.includes(tip)) return listed;
    // Some files leave features out of the Body's group: its Tip still reaches them.
    const reached = new Set<FcObject>();
    for (
      let o: FcObject | undefined = tip;
      o && !reached.has(o);
      o = doc.byName.get(link(o, 'BaseFeature')?.obj ?? '')
    ) {
      const profile = doc.byName.get(link(o, 'Profile')?.obj ?? '');
      reached.add(o);
      if (profile) reached.add(profile);
    }
    return [...reached, ...listed.filter((x) => !reached.has(x))];
  };
  const inBodies = new Set(bodies.flatMap((b) => [b.name, ...membersOf(b).map((m) => m.name)]));
  // A Body a Part workbench object is built from is not placed itself: that object, its result, is.
  // What holds an object, or a window's host, is not what it is built from.
  const linksOf = (x: FcObject) =>
    [...x.props.keys()].flatMap((p) =>
      NOT_BUILT_FROM.has(p)
        ? []
        : [...(link(x, p) ? [(link(x, p) as FcLink).obj] : []), ...links(x, p).map((l) => l.obj)],
    );
  const fromPart = new Set(doc.objects.filter((x) => x.type.startsWith('Part::')).flatMap(linksOf));
  // Containers carry their contents' placements: a Body's place is the product along its parents.
  const parentOf = new Map<string, FcObject>();
  for (const x of doc.objects) {
    if (x.type === 'App::Part' || x.type === 'Assembly::AssemblyObject')
      for (const l of links(x, 'Group')) parentOf.set(l.obj, x);
  }
  /** The containers above `x`, nearest first, each once: a file whose containers hold each other in a ring ends there. */
  const parentsOf = (x: FcObject): FcObject[] => {
    const out: FcObject[] = [];
    for (let a = parentOf.get(x.name); a && a !== x && !out.includes(a); a = parentOf.get(a.name)) out.push(a);
    return out;
  };
  const worldOf = (x: FcObject, within?: FcObject): FcPlacement => {
    let p = placement(x);
    for (const a of parentsOf(x)) {
      if (a === within) break;
      p = compose(placement(a), p);
    }
    return p;
  };
  const partOfBody = new Map<string, string>();
  // A hidden Body is not placed when others are shown: it is history, or a part of what they were made from.
  const shown = bodies.filter((b) => b.props.get('Visibility')?.children[0]?.attrs.value !== 'false');
  const hidden: typeof placed = [];
  for (const body of bodies) {
    const c = new BodyConverter(
      w,
      doc,
      membersOf(body),
      link(body, 'Tip')?.obj,
      body.label,
      notes,
      steps,
      files,
      checks,
      parameters,
      partOfBody,
    );
    c.convert();
    const consumed = fromPart.has(body.name) || membersOf(body).some((m) => fromPart.has(m.name));
    partOfBody.set(body.name, c.partId);
    // A Body's own colour, else its Tip's: older files colour the feature shown.
    const tipName = link(body, 'Tip')?.obj;
    const own = appearances.get(body.name);
    const look = own && !isDefaultColor(own.color) ? own : ((tipName ? appearances.get(tipName) : undefined) ?? own);
    if (look && (!isDefaultColor(look.color) || look.opacity < 1)) {
      styles.push({
        part: c.partId,
        row: (target) => ({
          id: w.ids('attr'),
          target,
          properties: {
            color: w.choice(look.color),
            ...(look.opacity < 1 ? { opacity: w.val(String(Math.round(look.opacity * 1000) / 1000)) } : {}),
          },
        }),
      });
    }
    if (consumed) continue;
    (shown.includes(body) ? placed : hidden).push({ part: c.partId, placement: worldOf(body) });
  }
  // A Part workbench shape a link places is a part of its own, once however many links name it.
  const shapeParts = new Map<string, string | undefined>();
  const partOfShape = (shape: FcObject): string | undefined => {
    if (!shapeParts.has(shape.name)) {
      const c = new BodyConverter(w, doc, [], undefined, shape.label, notes, steps, files, [], parameters);
      const kept = c.shape(shape, doc.programVersion ?? '');
      if (!kept) w.parts.pop();
      shapeParts.set(shape.name, kept ? c.partId : undefined);
    }
    return shapeParts.get(shape.name);
  };
  // Links place their target again: a Body, the Bodies of a Part, or a shape.
  for (const x of doc.objects.filter((y) => y.type === 'App::Link')) {
    if (x.props.get('Visibility')?.children[0]?.attrs.value === 'false') continue;
    const target = link(x, 'LinkedObject');
    const to = target && doc.byName.get(target.obj);
    if (!to) {
      notes.push({ severity: 'info', object: x.label, message: 'it links into another file, which is not read here' });
      continue;
    }
    if (integer(x, 'ElementCount') > 0) {
      notes.push({ severity: 'info', object: x.label, message: 'a link array is not imported' });
      continue;
    }
    const parent = parentOf.get(x.name);
    const at = compose(
      parent ? worldOf(parent) : IDENTITY,
      has(x, 'LinkPlacement') ? placement(x, 'LinkPlacement') : placement(x),
    );
    if (to.type.startsWith('Part::')) {
      const part = partOfShape(to);
      // The stored shape sits at its object's own placement, which a link replaces unless told to add to it.
      if (part) placed.push({ part, placement: bool(x, 'LinkTransform') ? at : compose(at, invert(placement(to))) });
      continue;
    }
    const held = to.type === 'PartDesign::Body' ? [to] : bodies.filter((b) => parentsOf(b).includes(to));
    for (const b of held) {
      const part = partOfBody.get(b.name);
      if (part) placed.push({ part, placement: compose(at, b === to ? IDENTITY : worldOf(b, to)) });
    }
  }
  // Files from before Bodies hold their PartDesign features at the top, in order.
  const loose = doc.objects.filter(
    (x) =>
      !inBodies.has(x.name) &&
      (x.type.startsWith('PartDesign::') ||
        (x.type === 'Sketcher::SketchObject' &&
          doc.objects.some((f) => f.type.startsWith('PartDesign::') && link(f, 'Sketch')?.obj === x.name))),
  );
  if (bodies.length === 0 && loose.some((x) => x.type.startsWith('PartDesign::'))) {
    const c = new BodyConverter(w, doc, loose, undefined, 'Body', notes, steps, files, checks, parameters);
    c.convert();
    placed.push({ part: c.partId, placement: IDENTITY });
    for (const x of loose) inBodies.add(x.name);
  }
  // The Part workbench's results: shapes nothing else in the file is built from.
  const used = new Set(doc.objects.flatMap(linksOf));
  const results = doc.objects.filter(
    (x) =>
      x.type.startsWith('Part::') &&
      !x.type.startsWith('Part::Part2D') &&
      !inBodies.has(x.name) &&
      !used.has(x.name) &&
      shapeFile(x) !== undefined &&
      x.props.get('Visibility')?.children[0]?.attrs.value !== 'false',
  );
  // Inside a container a shape is stored in that container's frame: the container's shapes make a part it places.
  const holders = new Map<FcObject | undefined, FcObject[]>();
  for (const x of results) holders.set(parentOf.get(x.name), [...(holders.get(parentOf.get(x.name)) ?? []), x]);
  // Past a budget of stored shape, in the file's order, the rest is left out; the first always comes in.
  let spent = 0;
  let over = 0;
  const within = (x: FcObject): boolean => {
    const size = files.get(shapeFile(x) as string)?.length ?? 0;
    if (spent > 0 && spent + size > SHOWN_SHAPES_MB * 1e6) {
      over++;
      return false;
    }
    spent += size;
    return true;
  };
  for (const [holder, held] of holders) {
    const c = new BodyConverter(
      w,
      doc,
      [],
      undefined,
      holder?.label ?? (bodies.length === 0 ? 'Part 1' : 'Part workbench shapes'),
      notes,
      steps,
      files,
      [],
      parameters,
    );
    const kept = held.filter((x) => within(x) && c.shape(x, doc.programVersion ?? ''));
    if (kept.length > 0) placed.push({ part: c.partId, placement: holder ? worldOf(holder) : IDENTITY });
    else w.parts.pop();
  }
  if (over > 0)
    notes.push({
      severity: 'warning',
      object: 'document',
      message: `${over === 1 ? 'a shape it shows was' : `${over} shapes it shows were`} left out: an import takes no more than ${SHOWN_SHAPES_MB} MB of the shapes FreeCAD stored`,
    });
  const joints = doc.objects.filter((x) => x.type === 'Assembly::JointGroup').flatMap((x) => links(x, 'Group'));
  if (joints.length > 0)
    notes.push({
      severity: 'info',
      object: 'document',
      message: `${joints.length === 1 ? 'a joint was' : `${joints.length} joints were`} left out: the parts come in where the assembly solved them`,
    });
  if (placed.length === 0) placed.push(...hidden);
  if (placed.length === 0)
    notes.push({
      severity: 'warning',
      object: 'document',
      message: 'the file has no PartDesign Body or Part workbench solid, so nothing was imported',
    });
  if (w.parts.length === 0) w.part('Part 1');

  const time = o.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const reportBytes = new TextEncoder().encode(
    JSON.stringify({ format: 'FreeCAD', version: doc.programVersion ?? '', notes }, null, 2),
  );
  const origin =
    o.source !== undefined
      ? {
          imported: {
            format: 'FreeCAD',
            version: doc.programVersion ?? '',
            source: w.asset(o.source, 'application/x-freecad', `${o.name ?? 'model'}.FCStd`),
            report: w.asset(reportBytes, 'application/json', 'import-report.json'),
          },
        }
      : { original: {} };
  const single = placed.length === 1 && isIdentity((placed[0] as (typeof placed)[number]).placement);
  const assembly = placed.length === 0 || single ? undefined : w.assembly(o.name ?? 'Assembly', placed);
  const firstPart = single ? (placed[0] as (typeof placed)[number]).part : (w.parts[0] as PartDraft).id;
  const document: Json = {
    format: 'tweakcad.document',
    schemaVersion: 2,
    namingRules: 1,
    id: o.ids('doc'),
    metadata: {
      name: o.name ?? bodies[0]?.label ?? 'FreeCAD model',
      description: '',
      createdAt: time,
      updatedAt: time,
      writer: { ...o.writer },
      origin,
    },
    properties: {},
    settings: {},
    parameters: parameters.tables,
    parts: w.parts.map((p) => w.emptyPart(p)),
    assemblies: assembly ? [assembly] : [],
    root: assembly ? { assembly: { id: assembly.id } } : { part: { id: firstPart } },
    folders: [],
    views: [],
    library: [],
    assets: w.assets,
    names: w.names.toJson(),
  };
  parameters.settle(document);
  if (parameters.dropped > 0)
    notes.push({
      severity: 'info',
      object: 'document',
      message: `${parameters.dropped} ${parameters.dropped === 1 ? 'expression reads' : 'expressions read'} what is not a parameter here, so ${parameters.dropped === 1 ? 'its value came' : 'their values came'} in as numbers`,
    });
  return {
    document,
    steps,
    notes,
    checks,
    styles,
    expressions: { carried: parameters.carried, dropped: parameters.dropped },
  };
}
