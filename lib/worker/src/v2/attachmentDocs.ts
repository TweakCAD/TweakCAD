/**
 * The part of the wrong-attachment suite: a plate built from several feature
 * types, with the edits the suite makes to it. Each model is a version-2
 * document; the edges and face its later features take are picked once on
 * the base design, as a saved document holds them.
 */
import type { GcsWrapper } from '@salusoft89/planegcs';
import type { OcctKernel } from 'occt-wasm';
import { makeSet, writeRecord, type EntityRecord, type NamedEntity, type Vec3 } from '@tweakcad/format';
import { DocBuilder } from './docBuilder';
import type { Evaluation } from './evaluate';
import { freezeFeature } from './freeze';
import type { Json, PartResult } from './context';

/** What an edit changes. Lengths in mm. */
export interface Params {
  width: number;
  depth: number;
  bossX: number;
  bossHeight: number;
  holeX: number;
  holeDiameter: number;
  filletRadius: number;
  /** A pocket in the top, inserted before the fillet. */
  pocket: boolean;
  /** A second hole, added after everything else. */
  secondHole: boolean;
  /** A slot through the plate, inserted before the fillet, that divides it in two. */
  slot: boolean;
  /** A fillet on another vertical edge, inserted before the first fillet. */
  earlierFillet: boolean;
  /** A fillet on the top edge the first fillet ends on, added at the end. */
  meetingFillet: boolean;
  /** The part's configuration: `large` makes the boss taller and the hole bigger. */
  size: 'small' | 'large';
  /** The first fillet frozen as the base design built it. */
  frozenFillet: boolean;
  /** Where the elliptical hole through the plate is centred along x. */
  ellipseX: number;
  /** The through hole's feature pattern along y: the seed and its copies, and their step. */
  holeCount: number;
  holeSpacing: number;
  /** The cap height of the text engraved in the top. */
  textSize: number;
}

export const BASE: Params = {
  width: 60,
  depth: 10,
  bossX: 10,
  bossHeight: 8,
  holeX: 45,
  holeDiameter: 6,
  filletRadius: 3,
  pocket: false,
  secondHole: false,
  slot: false,
  earlierFillet: false,
  meetingFillet: false,
  size: 'small',
  frozenFillet: false,
  ellipseX: 47,
  holeCount: 2,
  holeSpacing: -9,
  textSize: 4,
};

export interface Built {
  d: DocBuilder;
  /** Features off in this variant. */
  off: string[];
  /** The value objects the configuration overrides. */
  bossHeight: string;
  holeDiameter: string;
  size: Params['size'];
  /** The fillet to freeze as the base design built it. */
  frozen?: string;
}

/** The picks the later features take, recorded on the base design, and the names they use. */
export interface Picks {
  fillet: EntityRecord;
  chamfer: EntityRecord;
  earlier: EntityRecord;
  meeting: EntityRecord;
  bossTop: EntityRecord;
  rightTop: EntityRecord;
  names: Json;
}

const frameAt = (d: DocBuilder, z: number): Json => ({
  frame: {
    attach: {
      support: [{ standard: { name: 'xy' } }],
      mode: d.val('"plane"'),
      offset: d.val(`placement(vector(0 mm, 0 mm, ${z} mm), rotate(vector(0, 0, 1), 0 deg))`),
      flip: d.val('false'),
    },
  },
});

function hole(d: DocBuilder, z: number, x: number, y: number, diameter: number, id: string): string {
  return d.feature('core.hole', {
    placement: frameAt(d, z),
    positions: [{ id, at: { at: { v: d.val(`vector(${x} mm, ${y} mm, 0 mm)`) } } }],
    kind: d.val('"simple"'),
    diameter: d.val(`${diameter} mm`),
    depth: { throughAll: {} },
    tip: { flat: {} },
    thread: { none: {} },
  });
}

/** The id of the value object at `path` under a feature's inputs. */
export function valueIdIn(d: DocBuilder, feature: string, path: readonly (string | number)[]): string {
  const f = (((d.document().parts as Json[])[0] as Json).timeline as Json[]).find((x) => x.id === feature) as Json;
  let at: unknown = f.inputs;
  for (const step of path) at = (at as Record<string | number, unknown>)[step];
  return (at as Json).id as string;
}

/** The features before the fillet: a dimensioned plate, a boss joined on top, and a pocket (off unless `p.pocket`). */
export function prefix(p: Params): Built {
  const d = new DocBuilder();
  const off: string[] = [];
  const plate = d.sketch('xy', (x) => {
    const r = x.rect(0, 0, 58, 39);
    x.fixed(r.points[0] as string);
    x.horizontal(r.lines[0] as string);
    x.vertical(r.lines[1] as string);
    x.horizontal(r.lines[2] as string);
    x.vertical(r.lines[3] as string);
    x.distanceX(r.points[0] as string, r.points[1] as string, `${p.width} mm`);
    x.distanceY(r.points[0] as string, r.points[3] as string, '40 mm');
  });
  d.extrude({ sketch: plate.feature, profiles: [plate.region([1, 1])], sides: [{ distance: `${p.depth} mm` }] });
  const boss = d.sketch('xy', (x) => x.rect(p.bossX, 10, 15, 20), p.depth);
  const bossExtrude = d.extrude({
    sketch: boss.feature,
    profiles: [boss.region([p.bossX + 1, 11])],
    sides: [{ distance: `${p.bossHeight} mm` }],
    op: 'join',
  });
  const pocket = d.sketch('xy', (x) => x.rect(32, 26, 8, 8), p.depth);
  const cut = d.extrude({
    sketch: pocket.feature,
    profiles: [pocket.region([33, 27])],
    sides: [{ distance: '4 mm' }],
    op: 'cut',
    reversed: true,
  });
  if (!p.pocket) off.push(pocket.feature, cut);
  const slot = d.sketch('xy', (x) => x.rect(28, -1, 3, 42));
  const through = d.extrude({
    sketch: slot.feature,
    profiles: [slot.region([29, 5])],
    sides: [{ throughAll: true }],
    op: 'cut',
  });
  if (!p.slot) off.push(slot.feature, through);
  const bossHeight = valueIdIn(d, bossExtrude, ['sides', 0, 'extent', 'distance', 'd']);
  return { d, off, bossHeight, holeDiameter: '', size: p.size };
}

const CONFIG = new DocBuilder();
const [TABLE, SIZE, CFG] = [CONFIG.id('tbl'), CONFIG.id('par'), CONFIG.id('cfg')];
const def = (text: string) => ({ expr: { text, grammar: 1, refs: {} } });

/** The document as JSON: the `off` features suppressed, and the size configuration set to `b.size`. */
export function plainDocumentOf(b: Built): Json {
  const doc = structuredClone(b.d.document());
  const parts = doc.parts as Json[];
  const first = parts[0] as Json;
  first.parameters = [
    {
      id: TABLE,
      name: 'Sizes',
      parameters: [
        {
          id: SIZE,
          name: 'size',
          type: 'choice',
          options: ['small', 'large'],
          value: { id: b.d.id('val'), def: def(`"${b.size}"`) },
          range: { unbounded: {} },
          public: false,
          published: false,
          description: '',
        },
      ],
    },
  ];
  if (b.holeDiameter !== '') {
    first.configurations = [
      {
        id: CFG,
        input: { id: SIZE },
        rows: [
          { option: { equals: { literal: 'small' } }, overrides: [] },
          {
            option: { equals: { literal: 'large' } },
            overrides: [
              { value: { target: { value: { id: b.bossHeight } }, def: def('12 mm') } },
              { value: { target: { value: { id: b.holeDiameter } }, def: def('8 mm') } },
            ],
          },
        ],
      },
    ];
  }
  for (const part of parts) {
    for (const f of part.timeline as Json[]) {
      if (b.off.includes(f.id as string))
        ((f.suppressed as Json).def as Json).expr = { text: 'true', grammar: 1, refs: {} };
    }
  }
  return doc;
}

const HOLE = new DocBuilder();
const [HP1, HP2] = [HOLE.id('hp'), HOLE.id('hp')] as [string, string];

const fillet = (d: DocBuilder, edge: EntityRecord, radius: number) =>
  d.feature('core.fillet', {
    sets: [
      {
        targets: makeSet([{ entity: edge }]),
        radius: { constant: { s: d.val(`${radius} mm`) } },
        setback: d.val('0 mm'),
      },
    ],
  });

/** A post on the plate, joined, extruded up to the boss's top face: its cap follows that face. */
function post(d: DocBuilder, p: Params, top: EntityRecord): void {
  const s = d.sketch('xy', (x) => x.rect(2, 2, 4, 4), p.depth);
  d.feature('core.extrude', {
    profiles: makeSet([s.region([3, 3])]),
    sides: [{ extent: { toFace: { face: { entity: top }, offset: d.val('0 mm') } }, taper: d.val('0 deg') }],
    direction: { normal: { ref: { object: { feature: { id: s.feature } } }, reversed: d.val('false') } },
    thin: { solid: {} },
    operation: { op: d.val('"join"'), targets: { all: {} }, keepTools: d.val('false') },
  });
}

export const TEXT_AT: [number, number] = [33, 2];

/** "TL" engraved half a millimetre into the top, its baseline from `TEXT_AT`. */
function engrave(d: DocBuilder, p: Params, bytes: Uint8Array): void {
  const font = d.font(bytes, 'LilitaOne-Regular.ttf');
  const s = d.sketch('xy', (x) => x.text(font, 'TL', p.textSize, TEXT_AT), p.depth);
  d.extrude({
    sketch: s.feature,
    profiles: s.rows.map((r) => s.refOf(r.id)),
    sides: [{ distance: '0.5 mm' }],
    op: 'cut',
    reversed: true,
  });
}

/**
 * A shallow pocket in the top held 1.5 mm in from the plate's right edge,
 * which its sketch projects: drawn where the base design has it, the solve
 * moves it with the edge.
 */
function ledge(d: DocBuilder, p: Params, edge: EntityRecord): void {
  const x0 = BASE.width - 4.5;
  const s = d.sketch(
    'xy',
    (x) => {
      const ext = x.external({ entity: edge }, {});
      const origin = x.point(0, 0);
      x.fixed(origin);
      const r = x.rect(x0, 15, 3, 10);
      x.horizontal(r.lines[0] as string);
      x.vertical(r.lines[1] as string);
      x.horizontal(r.lines[2] as string);
      x.vertical(r.lines[3] as string);
      x.distanceX(r.points[0] as string, r.points[1] as string, '3 mm');
      x.distanceY(r.points[1] as string, r.points[2] as string, '10 mm');
      x.distanceY(origin, r.points[0] as string, '15 mm');
      x.constraint('distance', {
        a: { point: { id: r.points[1] } },
        b: { external: { id: ext } },
        value: d.val('1.5 mm'),
        solved: 0,
        label: { auto: {} },
      });
    },
    p.depth,
  );
  d.extrude({
    sketch: s.feature,
    profiles: [s.region([x0 + 1, 16])],
    sides: [{ distance: '0.5 mm' }],
    op: 'cut',
    reversed: true,
  });
}

/**
 * The suite's models on one kernel, engraved in the font `font` (the bytes of
 * a TrueType file). `evaluate` evaluates a document as the caller checks it; `keep` holds an evaluation made here until the caller
 * disposes of it.
 */
export function attachmentModels(
  k: OcctKernel,
  gcs: GcsWrapper,
  font: Uint8Array,
  evaluate: (doc: Json) => Evaluation,
  keep: (ev: Evaluation) => void,
) {
  /** `doc` with feature `id` frozen from a build of the base design. */
  function withFrozen(doc: Json, id: string): Json {
    const base = freezeFeature(plainDocumentOf(model(BASE)), k, id, { solver: gcs });
    keep(base.evaluation);
    const timeline = (d: Json) => ((d.parts as Json[])[0] as Json).timeline as Json[];
    const feature = timeline(doc).find((f) => f.id === id) as Json;
    feature.frozen = (timeline(base.document).find((f) => f.id === id) as Json).frozen;
    Object.assign(doc.assets as Json, base.document.assets);
    Object.assign(doc.names as Json, base.document.names);
    return doc;
  }

  /** The document of a model, its frozen fillet frozen. */
  const documentOf = (b: Built): Json => (b.frozen ? withFrozen(plainDocumentOf(b), b.frozen) : plainDocumentOf(b));

  let memo: Picks | undefined;
  /** The edges the fillets and chamfer take, picked once on the base design. */
  function picks(): Picks {
    if (memo) return memo;
    const b = prefix(BASE);
    const ev = evaluate(documentOf(b));
    const state = (ev.parts.get(b.d.partId) as PartResult).state;
    const all = [...state.entities.values()];
    const edgeAt = (at: Vec3) =>
      all.find((e) => {
        const m = e.kind === 'edge' ? (ev.adapter.measures(e.key).midpoint as Vec3) : undefined;
        return m !== undefined && Math.hypot(m[0] - at[0], m[1] - at[1], m[2] - at[2]) < 1e-6;
      }) as NamedEntity;
    const record = (e: NamedEntity) => writeRecord(e, state, ev.adapter);
    const bossTop = all.find((e) => {
      const c = e.kind === 'face' ? (ev.adapter.measures(e.key).centroid as Vec3) : undefined;
      return (
        c !== undefined &&
        Math.hypot(c[0] - (BASE.bossX + 7.5), c[1] - 20, c[2] - (BASE.depth + BASE.bossHeight)) < 1e-6
      );
    }) as NamedEntity;
    memo = {
      bossTop: record(bossTop),
      fillet: record(edgeAt([BASE.width, 40, BASE.depth / 2])),
      chamfer: record(edgeAt([BASE.bossX + 7.5, 10, BASE.depth + BASE.bossHeight])),
      earlier: record(edgeAt([0, 40, BASE.depth / 2])),
      meeting: record(edgeAt([BASE.width / 2, 40, BASE.depth])),
      rightTop: record(edgeAt([BASE.width, 20, BASE.depth])),
      names: ev.names.toJson() as Json,
    };
    return memo;
  }

  /**
   * The whole part: the prefix, a post up to the boss's top, a fillet on a
   * vertical edge, a chamfer on the boss and a through hole with a feature
   * pattern of it; off unless asked for, a fillet inserted before the first,
   * a second hole and a fillet meeting the first.
   */
  function model(p: Params): Built {
    const b = prefix(p);
    const { d } = b;
    const saved = picks();
    for (const name of Object.values(saved.names)) d.names.intern(name as never);
    post(d, p, saved.bossTop);
    const earlier = fillet(d, saved.earlier, 2);
    if (!p.earlierFillet) b.off.push(earlier);
    const main = fillet(d, saved.fillet, p.filletRadius);
    if (p.frozenFillet) b.frozen = main;
    d.feature('core.chamfer', {
      sets: [{ targets: makeSet([{ entity: saved.chamfer }]), size: { distance: { d: d.val('1 mm') } } }],
    });
    const first = hole(d, p.depth, p.holeX, 20, p.holeDiameter, HP1);
    b.holeDiameter = valueIdIn(d, first, ['diameter']);
    d.feature('core.pattern', {
      of: { features: makeSet([{ object: { feature: { id: first } } }]) },
      layout: {
        linear: {
          directions: [
            {
              direction: { axis: { axis: d.val('"y"'), reversed: d.val('false') } },
              count: d.val(String(p.holeCount)),
              spacing: { equal: { s: d.val(`${p.holeSpacing} mm`) } },
            },
          ],
        },
      },
      skip: makeSet([]),
      vary: [],
      operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
    });
    const second = hole(d, p.depth, 52, 8, 4, HP2);
    if (!p.secondHole) b.off.push(second);
    ledge(d, p, saved.rightTop);
    const meeting = fillet(d, saved.meeting, 1);
    if (!p.meetingFillet) b.off.push(meeting);
    const oval = d.sketch('xy', (x) =>
      x.curve('ellipse', { center: x.point(p.ellipseX, 32), majorEnd: x.point(p.ellipseX + 4, 32), minorRadius: 3 }),
    );
    d.extrude({
      sketch: oval.feature,
      profiles: [oval.region([p.ellipseX, 32])],
      sides: [{ throughAll: true }],
      op: 'cut',
    });
    engrave(d, p, font);
    return b;
  }

  return { model, documentOf, picks };
}
