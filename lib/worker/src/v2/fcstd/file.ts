/**
 * Writing a FreeCAD `.FCStd`: objects with their properties as `Document.xml`
 * and the shapes they hold as archive entries. FreeCAD reads the entries in the
 * order the document asks for them, so they are zipped in that order.
 *
 * Every object is written touched: a recompute rebuilds the tree from the
 * parameters, and until then FreeCAD shows the shapes stored here.
 */
import { zipSync } from 'fflate';

export type V3 = [number, number, number];
/** A unit quaternion `[x, y, z, w]`. */
export type Q = [number, number, number, number];

export interface FcPlacement {
  position: V3;
  rotation: Q;
}

export const IDENTITY: FcPlacement = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** Text as an XML attribute value. */
export const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/** A number as FreeCAD's XML reader takes it. */
export function num(v: number): string {
  if (!Number.isFinite(v)) return '0';
  return Object.is(v, -0) ? '0' : String(v);
}

export interface LinkSub {
  object: FcOut;
  subs: readonly string[];
}

/** One FreeCAD object being written. */
export class FcOut {
  private readonly props: string[] = [];
  private readonly expressions: { path: string; text: string }[] = [];

  constructor(
    readonly file: FcFile,
    readonly type: string,
    readonly name: string,
    readonly label: string,
  ) {
    this.string('Label', label);
  }

  private add(name: string, type: string, inner: string): void {
    this.props.push(`<Property name="${name}" type="${type}">${inner}</Property>`);
  }

  /** A property of a type this class has no helper for. */
  raw(name: string, type: string, inner: string): void {
    this.add(name, type, inner);
  }

  string(name: string, v: string): void {
    this.add(name, 'App::PropertyString', `<String value="${escape(v)}"/>`);
  }

  bool(name: string, v: boolean): void {
    this.add(name, 'App::PropertyBool', `<Bool value="${v ? 'true' : 'false'}"/>`);
  }

  /** A float-valued property: `App::PropertyLength`, `App::PropertyAngle`, `App::PropertyFloat`… */
  float(name: string, v: number, type = 'App::PropertyFloat'): void {
    this.add(name, type, `<Float value="${num(v)}"/>`);
  }

  length(name: string, v: number): void {
    this.float(name, v, 'App::PropertyLength');
  }

  angle(name: string, v: number): void {
    this.float(name, v, 'App::PropertyAngle');
  }

  integer(name: string, v: number, type = 'App::PropertyInteger'): void {
    this.add(name, type, `<Integer value="${Math.trunc(v)}"/>`);
  }

  /** An enumeration by its index. */
  enumeration(name: string, index: number): void {
    this.add(name, 'App::PropertyEnumeration', `<Integer value="${index}"/>`);
  }

  link(name: string, to: FcOut | undefined, type = 'App::PropertyLink'): void {
    this.add(name, type, `<Link value="${to ? to.name : ''}"/>`);
  }

  linkSub(name: string, to: FcOut | undefined, subs: readonly string[] = []): void {
    const inner = subs.map((s) => `<Sub value="${escape(s)}"/>`).join('');
    this.add(
      name,
      'App::PropertyLinkSub',
      `<LinkSub value="${to ? to.name : ''}" count="${subs.length}">${inner}</LinkSub>`,
    );
  }

  linkList(name: string, to: readonly FcOut[]): void {
    const inner = to.map((o) => `<Link value="${o.name}"/>`).join('');
    this.add(name, 'App::PropertyLinkList', `<LinkList count="${to.length}">${inner}</LinkList>`);
  }

  linkSubList(name: string, to: readonly LinkSub[]): void {
    const rows = to.flatMap((l) =>
      l.subs.length === 0 ? [{ obj: l.object.name, sub: '' }] : l.subs.map((s) => ({ obj: l.object.name, sub: s })),
    );
    const inner = rows.map((r) => `<Link obj="${r.obj}" sub="${escape(r.sub)}"/>`).join('');
    this.add(name, 'App::PropertyLinkSubList', `<LinkSubList count="${rows.length}">${inner}</LinkSubList>`);
  }

  vector(name: string, v: V3): void {
    this.add(
      name,
      'App::PropertyVector',
      `<PropertyVector valueX="${num(v[0])}" valueY="${num(v[1])}" valueZ="${num(v[2])}"/>`,
    );
  }

  placement(p: FcPlacement, name = 'Placement'): void {
    const [x, y, z, w] = p.rotation;
    const half = Math.acos(Math.max(-1, Math.min(1, w)));
    const s = Math.sin(half);
    const axis: V3 = s > 1e-12 ? [x / s, y / s, z / s] : [0, 0, 1];
    this.add(
      name,
      'App::PropertyPlacement',
      `<PropertyPlacement Px="${num(p.position[0])}" Py="${num(p.position[1])}" Pz="${num(p.position[2])}" Q0="${num(x)}" Q1="${num(y)}" Q2="${num(z)}" Q3="${num(w)}" A="${num(2 * half)}" Ox="${num(axis[0])}" Oy="${num(axis[1])}" Oz="${num(axis[2])}"/>`,
    );
  }

  /** A stored shape, as BREP text. */
  shape(brep: string, name = 'Shape'): void {
    const entry = `${this.name}.${name}.brp`;
    this.file.entry(entry, new TextEncoder().encode(brep));
    this.add(name, 'Part::PropertyPartShape', `<Part file="${entry}"/>`);
  }

  /** An expression binding `path` to FreeCAD expression `text`. */
  expression(path: string, text: string): void {
    this.expressions.push({ path, text });
  }

  xml(): string {
    const bag = [...this.props];
    if (this.expressions.length > 0) {
      const inner = this.expressions
        .map((e) => `<Expression path="${escape(e.path)}" expression="${escape(e.text)}"/>`)
        .join('');
      bag.push(
        `<Property name="ExpressionEngine" type="App::PropertyExpressionEngine"><ExpressionEngine count="${this.expressions.length}">${inner}</ExpressionEngine></Property>`,
      );
    }
    return `<Object name="${this.name}" Touched="1"><Properties Count="${bag.length}" TransientCount="0">${bag.join('')}</Properties></Object>`;
  }
}

/** A FreeCAD document being written. */
export class FcFile {
  readonly objects: FcOut[] = [];
  private readonly names = new Set<string>();
  private readonly entries = new Map<string, Uint8Array>();
  private readonly views: string[] = [];

  constructor(readonly label: string) {}

  /** An object named after `label`, unique in the file as FreeCAD names are: letters, digits and underscores. */
  add(type: string, label: string): FcOut {
    let stem = label.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=[0-9])/, '_');
    if (stem.length === 0) stem = 'Object';
    let name = stem;
    for (let i = 1; this.names.has(name); i++) name = `${stem}${String(i).padStart(3, '0')}`;
    this.names.add(name);
    const o = new FcOut(this, type, name, label);
    this.objects.push(o);
    return o;
  }

  entry(name: string, bytes: Uint8Array): void {
    this.entries.set(name, bytes);
  }

  /** The document's text. Properties are written in object order, and so the entries they name. */
  documentXml(): string {
    const list = this.objects.map((o) => `<Object type="${o.type}" name="${o.name}"/>`).join('\n');
    const data = this.objects.map((o) => o.xml()).join('\n');
    return `<?xml version='1.0' encoding='utf-8'?>
<Document SchemaVersion="4" ProgramVersion="1.1" FileVersion="1">
<Properties Count="1" TransientCount="0"><Property name="Label" type="App::PropertyString"><String value="${escape(this.label)}"/></Property></Properties>
<Objects Count="${this.objects.length}">
${list}
</Objects>
<ObjectData Count="${this.objects.length}">
${data}
</ObjectData>
</Document>
`;
  }

  /** Sets what the view provider of `o` holds: its colour, transparency and whether it shows. */
  view(o: FcOut, look: { color?: string; opacity?: number; visible: boolean }): void {
    const props = [
      `<Property name="Visibility" type="App::PropertyBool"><Bool value="${look.visible ? 'true' : 'false'}"/></Property>`,
    ];
    if (look.color) {
      const packed = (parseInt(look.color.slice(1), 16) * 256) >>> 0;
      props.push(`<Property name="ShapeColor" type="App::PropertyColor"><PropertyColor value="${packed}"/></Property>`);
    }
    if (look.opacity !== undefined && look.opacity < 1) {
      props.push(
        `<Property name="Transparency" type="App::PropertyPercent"><Integer value="${Math.round((1 - look.opacity) * 100)}"/></Property>`,
      );
    }
    this.views.push(
      `<ViewProvider name="${o.name}" expanded="0"><Properties Count="${props.length}" TransientCount="0">${props.join('')}</Properties></ViewProvider>`,
    );
  }

  /** FreeCAD reads a `Camera` after the view providers and fails the file without one; an empty one keeps its own view. */
  private guiXml(): string {
    return `<?xml version='1.0' encoding='utf-8'?>
<Document SchemaVersion="1">
<ViewProviderData Count="${this.views.length}">
${this.views.join('\n')}
</ViewProviderData>
<Camera settings=""/>
</Document>
`;
  }

  /** The `.FCStd` archive. */
  bytes(): Uint8Array {
    const xml = this.documentXml();
    const zip: Record<string, Uint8Array> = { 'Document.xml': new TextEncoder().encode(xml) };
    for (const m of xml.matchAll(/<Part file="([^"]+)"/g)) {
      const data = this.entries.get(m[1] as string);
      if (data) zip[m[1] as string] = data;
    }
    if (this.views.length > 0) zip['GuiDocument.xml'] = new TextEncoder().encode(this.guiXml());
    return zipSync(zip, { level: 6 });
  }
}
