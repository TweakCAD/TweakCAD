/**
 * Every feature panel's read and build, over documents whose plain choice,
 * text and flag values (operations, axes, the reversed, ruled, closed and
 * copy flags, modes, sizes, classes) are each bound to a parameter of the
 * same value: the panel reads the same form as from the literals, and OK
 * on the untouched form writes every bound value back as it was.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPlainObject, makeSet, newId } from '@tweakcad/format';
import { Editor, seededIds, type Doc, type Json } from '@tweakcad/editor';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import { Docs } from '@tweakcad/worker/src/v2/assemblyDocs';
import { buildDerive, readDerive } from '../assembly/derive';
import { buildAsmPattern, newAsmDirection, newAsmPatternForm, readAsmPattern } from '../assembly/asmFeatures';
import { assemblyOf, rowsOf } from '../assembly/assembly';
import { buildChamfer, buildFillet, readChamfer, readFillet } from './blends';
import {
  buildBoolean,
  buildMirror,
  buildMove,
  buildPattern,
  buildRemoveBody,
  buildShell,
  readBoolean,
  readMirror,
  readMove,
  readPattern,
  readRemoveBody,
  readShell,
} from './bodyFeatures';
import { buildConstruction, CONSTRUCTION_TYPES, readConstruction, type ConstructionKind } from './construction';
import { buildExtrude, readExtrude, type ExtrudeForm, type ExtrudeProfile } from './extrude';
import { at, ValueSlots, type Built, type FeatureTarget } from './feature';
import { buildHole, readHole } from './hole';
import { buildLoft, readLoft } from './loft';
import { buildPrimitive, readPrimitive } from './primitive';
import { buildRevolve, readRevolve } from './revolve';
import { buildSweep, readSweep } from './sweep';
import { buildThread, readThread } from './thread';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolvePath(HERE, '../../../lib/testing/fixtures/v2');

/** A panel's model: the form a feature's inputs read as, and the inputs a form builds. */
interface PanelModel {
  read(doc: Doc, part: string, inputs: Json, feature: string): unknown;
  build(doc: Doc, target: FeatureTarget, form: never, values: ValueSlots): Built;
}

const plain = <F>(
  read: (doc: Doc, part: string, inputs: Json) => F,
  build: (doc: Doc, target: FeatureTarget, form: F, values: ValueSlots) => Built,
): PanelModel => ({
  read: (doc, part, inputs) => read(doc, part, inputs),
  build: build as PanelModel['build'],
});

const MODELS: Record<string, PanelModel> = {
  'core.hole': plain(readHole, buildHole),
  'core.thread': plain(readThread, buildThread),
  'core.fillet': plain(readFillet, buildFillet),
  'core.chamfer': plain(readChamfer, buildChamfer),
  'core.shell': plain(readShell, buildShell),
  'core.pattern': plain(readPattern, buildPattern),
  'core.mirror': plain(readMirror, buildMirror),
  'core.move': plain(readMove, buildMove),
  'core.boolean': plain(readBoolean, buildBoolean),
  'core.removeBody': plain(readRemoveBody, (_doc, target, form) => buildRemoveBody(_doc, target, form)),
  'core.primitive': plain(readPrimitive, buildPrimitive),
  'core.revolve': plain(readRevolve, buildRevolve),
  'core.loft': plain(readLoft, buildLoft),
  'core.sweep': plain(readSweep, buildSweep),
  'core.derive': plain(readDerive, buildDerive),
  'core.extrude': {
    read: (doc, part, _inputs, feature) => {
      const read = readExtrude(doc, part, feature);
      return read && { form: read.form, profiles: read.profiles };
    },
    build: ((
      doc: Doc,
      target: FeatureTarget,
      read: { form: ExtrudeForm; profiles: ExtrudeProfile[] },
      values: ValueSlots,
    ) => buildExtrude(doc, target, read.form, read.profiles, values)) as PanelModel['build'],
  },
  ...Object.fromEntries(
    (Object.entries(CONSTRUCTION_TYPES) as [ConstructionKind, string][]).map(([kind, type]) => [
      type,
      plain(readConstruction(kind), buildConstruction),
    ]),
  ),
};

/** The feature types the panels write, as their sources name them. */
function panelTypes(): Set<string> {
  const types = new Set<string>(Object.values(CONSTRUCTION_TYPES));
  for (const dir of [HERE, resolvePath(HERE, '../assembly')]) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('Panel.tsx') || f.endsWith('Panels.tsx'))) {
      for (const m of readFileSync(join(dir, file), 'utf8').matchAll(/type: '(core\.[A-Za-z]+)'/g))
        types.add(m[1] as string);
    }
  }
  types.add('core.extrude');
  return types;
}

const PLAIN = /^(?:"(?:[^"\\]|\\.)*"|true|false)$/;

/**
 * Binds each plain text and flag value of `inputs` to a new parameter of
 * the part holding that literal; the paths it bound.
 */
function bindLiterals(part: Json, inputs: Json): (string | number)[][] {
  const tables = (part.parameters ??= []) as Json[];
  if (tables.length === 0) tables.push({ id: newId('tbl'), name: 'Bound', parameters: [] });
  const table = tables[0] as Json;
  const paths: (string | number)[][] = [];
  const walk = (v: unknown, path: (string | number)[]) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, [...path, i]));
    if (!isPlainObject(v)) return;
    const expr = at(v, 'def', 'expr');
    if (typeof v.id === 'string' && isPlainObject(expr) && PLAIN.test(String(expr.text).trim())) {
      const n = paths.length;
      const text = String(expr.text).trim();
      const id = newId('par');
      (table.parameters as Json[]).push({
        id,
        name: `b${n}`,
        description: '',
        public: false,
        published: false,
        range: { unbounded: {} },
        type: text.startsWith('"') ? 'text' : 'boolean',
        value: { id: newId('val'), def: { expr: { grammar: 1, refs: {}, text } } },
      });
      v.def = { expr: { grammar: 1, refs: { [`b${n}`]: { parameter: { id } } }, text: `b${n}` } };
      paths.push(path);
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  walk(inputs, []);
  return paths;
}

interface Case {
  name: string;
  doc: Doc;
}

function fixtureCases(): Case[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.cadjson'))
    .map((f) => ({
      name: f.replace(/\.cadjson$/, ''),
      doc: JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as Doc,
    }));
}

/** A part with a loft through two squares and a sweep of a square along a polyline: features no fixture holds. */
function loftAndSweep(): Case {
  const d = new DocBuilder();
  const square = (half: number, z: number) => ({
    profiles: makeSet([
      d.sketch('xy', (s) => s.rect(-half, -half, 2 * half, 2 * half), z).region([0, 0]),
    ]) as unknown as Json,
  });
  const operation = (op: string) => ({ op: d.val(`"${op}"`), targets: { all: {} }, keepTools: d.val('false') });
  d.feature('core.loft', {
    sections: [square(5, 0), square(3, 10)].map((section) => ({ id: d.id('sec'), section })),
    rails: [],
    ruled: d.val('true'),
    closed: d.val('false'),
    operation: operation('new'),
  });
  let lines: string[] = [];
  const path = d.sketch('xz', (s) => {
    const ids = [s.point(0, 0), s.point(0, -20), s.point(20, -20)];
    lines = [s.line(ids[0] as string, ids[1] as string), s.line(ids[1] as string, ids[2] as string)];
  });
  const curve = (id: string) => ({ object: { curve: { sketch: { id: path.feature }, id } } });
  d.feature('core.sweep', {
    sections: [{ id: d.id('sec'), section: square(2, 0) }],
    path: lines.map(curve),
    orientation: { followPath: {} },
    operation: operation('join'),
  });
  return { name: 'loft and sweep', doc: d.document() as Doc };
}

/** Each feature a panel edits in `c`, read and built with its plain values bound; what went wrong, and the types that had a value to bind. */
function walk(c: Case): { failures: string[]; types: Set<string> } {
  const failures: string[] = [];
  const types = new Set<string>();
  {
    for (const [p, part] of ((c.doc.parts as Json[]) ?? []).entries()) {
      for (const feature of (part.timeline as Json[]) ?? []) {
        const model = MODELS[feature.type as string];
        if (!model || !isPlainObject(feature.inputs)) continue;
        const id = feature.id as string;
        const plainForm = model.read(c.doc, part.id as string, feature.inputs, id);
        if (!plainForm) continue;
        const doc = structuredClone(c.doc);
        const boundPart = (doc.parts as Json[])[p] as Json;
        const row = (boundPart.timeline as Json[]).find((f) => f.id === id) as Json;
        const inputs = row.inputs as Json;
        const paths = bindLiterals(boundPart, inputs);
        if (paths.length === 0) continue;
        types.add(feature.type as string);
        const where = `${feature.type as string} ${String(feature.name)}`;
        const form = model.read(doc, boundPart.id as string, inputs, id);
        if (JSON.stringify(form) !== JSON.stringify(plainForm))
          failures.push(
            `${where}: reads ${JSON.stringify(form).slice(0, 300)}, not ${JSON.stringify(plainForm).slice(0, 300)}`,
          );
        let n = 0;
        const values = new ValueSlots(() => `val_new${n++}`, inputs, doc);
        const built = model.build(
          doc,
          { part: boundPart.id as string, feature: id, base: inputs },
          form as never,
          values,
        );
        if (!built.ok) {
          failures.push(`${where}: OK refuses: ${built.message}`);
          continue;
        }
        for (const path of paths) {
          const written = at(built.inputs, ...path);
          if (JSON.stringify(written) !== JSON.stringify(at(inputs, ...path)))
            failures.push(`${where} ${path.join('.')}: writes ${JSON.stringify(written)}`);
        }
      }
    }
  }
  return { failures, types };
}

describe('panel fields bound to parameters', () => {
  const cases = [...fixtureCases(), loftAndSweep()];
  const results = new Map(cases.map((c) => [c.name, walk(c)]));

  it('every panel that writes a feature is walked', () => {
    expect([...panelTypes()].filter((t) => !(t in MODELS))).toEqual([]);
  });

  it.each(cases.map((c) => [c.name] as const))('%s: reads the same, and OK writes every bound value back', (name) => {
    expect(results.get(name)?.failures).toEqual([]);
  });

  it('binds a value of every panel that has a choice or flag field', () => {
    const walked = new Set([...results.values()].flatMap((r) => [...r.types]));
    // Fillet, chamfer and remove-body panels have no such field. The fixtures place their construction
    // points and frames by a fixed frame; an attached one reads its mode and flip as planes and axes do.
    const none = ['core.fillet', 'core.chamfer', 'core.removeBody', 'core.constructionPoint', 'core.constructionFrame'];
    const fields = Object.keys(MODELS).filter((t) => !none.includes(t));
    expect(fields.filter((t) => !walked.has(t))).toEqual([]);
  });
});

describe('assembly pattern fields bound to parameters', () => {
  it('reads a bound reverse flag and keeps it through OK', () => {
    const d = new Docs(7);
    const block = d.part('Block');
    block.box('10 mm', '10 mm', '10 mm');
    const a = d.assembly('Row');
    const inst = a.instance({ part: { id: block.id } }, { grounded: true });
    const editor = new Editor(d.document({ assembly: { id: a.id } }) as Doc, { ids: seededIds(3) });
    const form = {
      ...newAsmPatternForm(editor, a.id, [inst]),
      directions: [{ ...newAsmDirection('x'), reversed: true }],
    };
    const written = buildAsmPattern(editor, a.id, form);
    if (!written.ok) throw new Error(written.message);
    for (const command of written.commands) {
      const r = editor.dispatch(command);
      if (!r.ok) throw new Error(r.error.message);
    }
    const asm = assemblyOf(editor.document, a.id) as Json;
    const row = rowsOf(asm, 'timeline').find((f) => f.type === 'core.asm.pattern') as Json;
    const doc = structuredClone(editor.document);
    const boundAsm = ((doc.assemblies as Json[]) ?? []).find((x) => x.id === a.id) as Json;
    const boundRow = rowsOf(boundAsm, 'timeline').find((f) => f.id === row.id) as Json;
    const paths = bindLiterals(doc, boundAsm, boundRow.inputs as Json);
    expect(paths.length).toBeGreaterThan(0);
    const bound = new Editor(doc, { ids: seededIds(5) });
    const read = readAsmPattern(
      bound,
      rowsOf(assemblyOf(bound.document, a.id), 'timeline').find((f) => f.id === row.id) as Json,
    );
    expect(read.directions[0]?.reversed).toBe(true);
    const reversedPath = ['layout', 'linear', 'directions', 0, 'direction', 'axis', 'reversed'];
    expect(read.values.boundText(reversedPath, true)).toMatch(/^b\d+$/);
    const again = buildAsmPattern(bound, a.id, read);
    if (!again.ok) throw new Error(again.message);
    const replaced = again.commands.find((cmd) => cmd.type === 'replaceInput') as { with: Json } | undefined;
    expect(replaced).toBeDefined();
    for (const path of paths) expect(at(replaced?.with, ...path)).toEqual(at(boundRow.inputs, ...path));
  });
});
