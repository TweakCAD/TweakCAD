/**
 * Sketch text (8 `text`): the fonts the text tool offers, a font as a
 * library entry with its file in the assets, text rows, and their glyph
 * contours laid out as evaluation lays them out (the evaluator's own
 * layout), so the editor solves, draws and writes fates for them.
 */
import type { Font } from 'opentype.js';
import { contentHash, isPlainObject, nameHash, type SolvedCurve, type ValueEvaluator } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import { fontOf, layoutText, type TextPlacement } from '@tweakcad/worker/src/v2/sketchText';
import { table, type P2, type RowMaker } from './rows';
import lilitaOneUrl from '../assets/fonts/LilitaOne-Regular.ttf?url';
import bebasNeueUrl from '../assets/fonts/BebasNeue-Regular.ttf?url';
import atkinsonBoldUrl from '../assets/fonts/AtkinsonHyperlegible-Bold.ttf?url';

/** The fonts bundled with the app (static TTFs under the SIL Open Font License, licences beside the files). */
export const SKETCH_FONTS = [
  { id: 'lilita-one', label: 'Lilita One', file: 'LilitaOne-Regular.ttf', url: lilitaOneUrl },
  { id: 'bebas-neue', label: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', url: bebasNeueUrl },
  {
    id: 'atkinson-bold',
    label: 'Atkinson Hyperlegible Bold',
    file: 'AtkinsonHyperlegible-Bold.ttf',
    url: atkinsonBoldUrl,
  },
] as const;

export type SketchFontId = (typeof SKETCH_FONTS)[number]['id'];

export const DEFAULT_SKETCH_FONT: SketchFontId = 'lilita-one';

/** What the text tool writes. */
export interface TextOptions {
  string: string;
  font: SketchFontId;
  /** Cap height, mm. */
  size: number;
}

/** A font ready to write text in: parsed, with the file it came from. */
export interface LoadedFont {
  font: Font;
  bytes: Uint8Array;
  /** Its content hash, the asset key. */
  hash: string;
  name: string;
}

const LIBRARY = { type: 'library' } as const;
const TEXT = { type: 'text' } as const;
const LENGTH = { type: 'number', quantity: 'length' } as const;
const PLACEMENT = { type: 'placement' } as const;

/** A font file parsed and keyed by its content hash. */
export function loadFont(bytes: Uint8Array, name: string): LoadedFont {
  const hash = contentHash(bytes);
  return { font: fontOf(hash, bytes), bytes, hash, name };
}

const loading = new Map<SketchFontId, Promise<LoadedFont>>();

/** Fetches and parses a bundled font, once. */
export function loadSketchFont(id: SketchFontId): Promise<LoadedFont> {
  let pending = loading.get(id);
  if (!pending) {
    const def = SKETCH_FONTS.find((f) => f.id === id);
    if (!def) return Promise.reject(new Error(`There is no font ${id}`));
    pending = fetch(def.url)
      .then((res) => {
        if (!res.ok) throw new Error(`The font ${def.label} did not load (${res.status})`);
        return res.arrayBuffer();
      })
      .then((buffer) => loadFont(new Uint8Array(buffer), def.label));
    // A failed load is tried again next time.
    pending.catch(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function decode(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The library entry naming a font file, and the asset row holding it (11, 13.1). */
export function fontEntry(font: LoadedFont, id: string): { entry: Json; assets: Record<string, Json> } {
  const content = { inline: { definition: { asset: font.hash } } };
  return {
    entry: { id, hash: nameHash(content), kind: 'font', content, source: { local: {} }, name: font.name },
    assets: {
      [font.hash]: {
        mediaType: 'font/ttf',
        name: `${font.name}.ttf`,
        size: font.bytes.length,
        data: { inline: { base64: base64(font.bytes) } },
      },
    },
  };
}

/** The document's font entry holding this font file, if it has one. */
export function fontEntryIn(doc: Doc, hash: string): string | undefined {
  const library = Array.isArray(doc.library) ? (doc.library as Json[]) : [];
  return library.find(
    (e) => e.kind === 'font' && isPlainObject(e.content) && JSON.stringify(e.content).includes(`"asset":"${hash}"`),
  )?.id as string | undefined;
}

/** Every font the document's library holds inline, parsed, by entry id. */
export function fontsIn(doc: Doc): Map<string, ReturnType<typeof fontOf>> {
  const out = new Map<string, ReturnType<typeof fontOf>>();
  const library = Array.isArray(doc.library) ? (doc.library as Json[]) : [];
  const assets = isPlainObject(doc.assets) ? doc.assets : {};
  for (const e of library) {
    if (e.kind !== 'font' || !isPlainObject(e.content) || !isPlainObject(e.content.inline)) continue;
    const definition = e.content.inline.definition;
    const hash = isPlainObject(definition) ? definition.asset : undefined;
    const row = typeof hash === 'string' ? assets[hash] : undefined;
    const data =
      isPlainObject(row) && isPlainObject(row.data) && isPlainObject(row.data.inline)
        ? row.data.inline.base64
        : undefined;
    if (typeof hash !== 'string' || typeof data !== 'string') continue;
    try {
      out.set(e.id as string, fontOf(hash, decode(data)));
    } catch {
      // A font file that cannot be read leaves its text unbuilt, as evaluation pauses on it.
    }
  }
  return out;
}

/** A straight text row with its baseline from `at` along the sketch's x. */
export function textRow(make: RowMaker, options: { string: string; library: string; size: number; at: P2 }): Json {
  const [x, y] = options.at;
  return {
    id: make.id('txt'),
    string: make.value(JSON.stringify(options.string)),
    font: {
      id: make.id('val'),
      def: { expr: { text: 'typeface', grammar: 1, refs: { typeface: { library: { id: options.library } } } } },
    },
    size: make.value(`${options.size} mm`),
    frame: {
      fixed: {
        placement: make.value(
          `placement(vector(${round(x)} mm, ${round(y)} mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))`,
        ),
      },
    },
    path: { straight: {} },
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Where a fixed text frame puts the baseline in the sketch: its position, and the turn of its x about the sketch normal. */
export function placementOf(values: ValueEvaluator, frame: unknown): TextPlacement | null {
  if (!isPlainObject(frame) || !isPlainObject(frame.fixed)) return null;
  const p = values.literal(frame.fixed.placement, PLACEMENT) as unknown as { position: number[]; rotation: number[] };
  const [qx, qy, qz, qw] = p.rotation as [number, number, number, number];
  // The rotated x axis: the quaternion's first column.
  const xx = 1 - 2 * (qy * qy + qz * qz);
  const xy = 2 * (qx * qy + qw * qz);
  return { origin: [p.position[0] as number, p.position[1] as number], angle: Math.atan2(xy, xx) };
}

export interface TextRowFields {
  string: string;
  library: string;
  size: number;
  placement: TextPlacement;
}

/** A text row's fields as values give them, or null when they cannot be read. */
export function textFields(values: ValueEvaluator, row: Json): TextRowFields | null {
  try {
    if (!isPlainObject(row.path) || !('straight' in row.path)) return null;
    const placement = placementOf(values, row.frame);
    if (!placement) return null;
    return {
      string: values.literal(row.string, TEXT) as string,
      library: values.literal(row.font, LIBRARY) as string,
      size: values.number(row.size, LENGTH),
      placement,
    };
  } catch {
    return null;
  }
}

/**
 * The glyph contours of every text row, as evaluation lays them out; null
 * when one cannot be laid out here (a font not held, a curved path), so a
 * caller writes no fates rather than wrong ones.
 */
export function textGlyphs(
  inputs: Json,
  values: ValueEvaluator,
  fonts: ReadonlyMap<string, ReturnType<typeof fontOf>>,
): SolvedCurve[] | null {
  const out: SolvedCurve[] = [];
  for (const row of table(inputs, 'text')) {
    const fields = textFields(values, row);
    const font = fields ? fonts.get(fields.library) : undefined;
    if (!fields || !font) return null;
    try {
      out.push(...layoutText(font, row.id as string, fields.string, fields.size, fields.placement));
    } catch {
      return null;
    }
  }
  return out;
}
