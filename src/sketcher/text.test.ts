import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GcsWrapper } from '@salusoft89/planegcs';
import { detectRegions, type SolvedSketch } from '@tweakcad/format';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Json } from './rows';
import { solvedSketchOf } from './solve';
import { loadFont, type LoadedFont, type SketchFontId } from './text';
import { openTestSession, readsClean, rowsOf, type TestSession } from './testKit';
import { loadTestSolver } from './testSetup';
import { WorkingValues } from './values';

let gcs: GcsWrapper;
let font: LoadedFont;
let bebas: LoadedFont;
let custom: LoadedFont;
beforeAll(async () => {
  gcs = await loadTestSolver();
  const here = dirname(fileURLToPath(import.meta.url));
  const file = (name: string) => new Uint8Array(readFileSync(resolve(here, '../assets/fonts', name)));
  font = loadFont(file('LilitaOne-Regular.ttf'), 'Lilita One');
  bebas = loadFont(file('BebasNeue-Regular.ttf'), 'Bebas Neue');
  custom = loadFont(file('AtkinsonHyperlegible-Bold.ttf'), 'A font of my own');
});

function rectangle(t: TestSession, a: [number, number], b: [number, number]): void {
  t.session.setTool('rectangle');
  t.click(...a);
  t.click(...b);
}

function placeText(t: TestSession, string: string, at: [number, number]): void {
  t.session.setTool('text');
  t.session.setTextFont(font);
  t.session.setTextOptions({ string, size: 8 });
  t.move(...at);
  t.click(...at);
  expect(t.session.getState().message).toBeNull();
}

describe('text tool', () => {
  it('places text with its font as a library entry, in one undo step', () => {
    const t = openTestSession(gcs);
    const before = t.editor.save();
    placeText(t, 'Hi', [10, 10]);
    const doc = t.editor.document;
    const library = doc.library as Json[];
    expect(library).toHaveLength(1);
    expect(library[0]).toMatchObject({ kind: 'font', name: 'Lilita One' });
    expect(Object.keys(doc.assets as Json)).toEqual([font.hash]);
    const text = rowsOf(t.inputs(), 'text');
    expect(text).toHaveLength(1);
    expect(readsClean(t.editor)).toBe(true);
    expect(t.editor.undo()).toBe(true);
    expect(t.editor.save()).toBe(before);
    t.editor.redo();

    // A second text reuses the entry.
    placeText(t, 'Yo', [10, 30]);
    expect(t.editor.document.library as Json[]).toHaveLength(1);
    expect(rowsOf(t.inputs(), 'text')).toHaveLength(2);
    // Its glyphs are laid out, so the sketch's regions include them.
    const sketch = solvedSketchOf(t.inputs(), new WorkingValues(t.editor.document), [], null);
    expect(sketch).toBeNull();
  });

  it('commits with the solved sketch, so text inside a picked region writes its fate', () => {
    const t = openTestSession(gcs);
    rectangle(t, [0.5, 0.5 + 1], [60, 40]);
    const inputs = t.inputs();
    const [detected] = detectRegions(
      solvedSketchOf(inputs, new WorkingValues(t.editor.document)) as SolvedSketch,
    ).regions;
    const picked = t.editor.newId('reg');
    expect(
      t.editor.dispatch({
        type: 'pickRegion',
        sketch: t.host.feature,
        region: { id: picked, loop: detected?.loop, holes: detected?.holes } as unknown as Json,
      }).ok,
    ).toBe(true);
    placeText(t, 'O', [20, 12]);
    const inputsAfter = t.inputs();
    // The glyph splits the picked region: the part round the letter, the letter, and its counter, each from it.
    const regions = rowsOf(inputsAfter, 'regions');
    expect(regions).toHaveLength(3);
    for (const r of regions) expect(r.origin).toEqual({ from: { id: picked } });
    expect(rowsOf(inputsAfter, 'retired').map((r) => [r.id, r.fate])).toEqual([[picked, { split: {} }]]);
    expect(regions.some((r) => JSON.stringify(r.holes).includes('"glyph"'))).toBe(true);
    expect(readsClean(t.editor)).toBe(true);
  });

  it('a click on text edits it; delete removes it', () => {
    const t = openTestSession(gcs);
    placeText(t, 'I', [10, 10]);
    const id = rowsOf(t.inputs(), 'text')[0]?.id as string;
    // The stem of an I runs up from the baseline.
    let hit: [number, number] | null = null;
    for (let x = 10; x < 16 && !hit; x += 0.1) {
      t.move(x, 12);
      if (t.session.getState().hover === id) hit = [x, 12];
    }
    expect(hit).not.toBeNull();
    t.click(...(hit as [number, number]));
    expect(t.session.getState().text.editing).toBe(id);
    t.session.setTextOptions({ string: 'II', size: 12 });
    const result = t.session.updateText();
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    const row = rowsOf(t.inputs(), 'text')[0] as Json;
    expect(((row.string as Json).def as Json).expr).toMatchObject({ text: '"II"' });
    expect(readsClean(t.editor)).toBe(true);
    t.session.setTool('select');
    t.session.select([id]);
    t.key('Delete');
    expect(rowsOf(t.inputs(), 'text')).toHaveLength(0);
  });
});

describe('region fates of edits that change values', () => {
  function pickRectangle(t: TestSession): string {
    rectangle(t, [0.5, 0.5 + 1], [60, 40]);
    const [detected] = detectRegions(
      solvedSketchOf(t.inputs(), new WorkingValues(t.editor.document)) as SolvedSketch,
    ).regions;
    const picked = t.editor.newId('reg');
    expect(
      t.editor.dispatch({
        type: 'pickRegion',
        sketch: t.host.feature,
        region: { id: picked, loop: detected?.loop, holes: detected?.holes } as unknown as Json,
      }).ok,
    ).toBe(true);
    return picked;
  }

  it('retires a picked region whose curves become construction curves', () => {
    const t = openTestSession(gcs);
    const picked = pickRectangle(t);
    const lines = rowsOf(t.inputs(), 'curves').map((c) => c.id as string);
    expect(t.session.setConstruction(lines, true).ok).toBe(true);
    const inputs = t.inputs();
    expect(rowsOf(inputs, 'regions')).toEqual([]);
    expect(rowsOf(inputs, 'retired').map((r) => r.id)).toContain(picked);
  });

  it('writes the fates of the text as edited, not as it was', () => {
    const t = openTestSession(gcs);
    pickRectangle(t);
    placeText(t, 'O', [20, 12]);
    expect(rowsOf(t.inputs(), 'regions')).toHaveLength(3);
    const id = rowsOf(t.inputs(), 'text')[0]?.id as string;
    // A click on the letter edits it.
    let hit: [number, number] | null = null;
    for (let x = 20; x < 28 && !hit; x += 0.1) {
      t.move(x, 16);
      if (t.session.getState().hover === id) hit = [x, 16];
    }
    t.click(...(hit as [number, number]));
    expect(t.session.getState().text.editing).toBe(id);
    t.session.setTextOptions({ string: 'I', size: 8 });
    const result = t.session.updateText();
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    // The rectangle less the letter, and the letter: an I has no counter.
    expect(rowsOf(t.inputs(), 'regions')).toHaveLength(2);
    expect(readsClean(t.editor)).toBe(true);
  });
});

describe('editing text keeps its font', () => {
  /** Places text in a font, then clicks it to edit it; the tool's font is Lilita One again first. */
  function placeAndEdit(t: TestSession, inFont: LoadedFont, id: SketchFontId): string {
    t.session.setTool('text');
    t.session.setTextOptions({ string: 'I', size: 8, font: id });
    t.session.setTextFont(inFont);
    t.move(10, 10);
    t.click(10, 10);
    expect(t.session.getState().message).toBeNull();
    const row = rowsOf(t.inputs(), 'text')[0] as Json;
    t.session.setTextOptions({ font: 'lilita-one' });
    t.session.setTextFont(font);
    let hit: [number, number] | null = null;
    for (let x = 10; x < 16 && !hit; x += 0.1) {
      t.move(x, 12);
      if (t.session.getState().hover === row.id) hit = [x, 12];
    }
    t.click(...(hit as [number, number]));
    expect(t.session.getState().text.editing).toBe(row.id);
    return fontOfText(t);
  }

  const fontOfText = (t: TestSession) => JSON.stringify(((rowsOf(t.inputs(), 'text')[0] as Json).font as Json).def);

  it('shows the edited text in its own font and keeps it when only the string changes', () => {
    const t = openTestSession(gcs);
    const library = placeAndEdit(t, bebas, 'bebas-neue');
    expect(t.session.getState().text).toMatchObject({ font: 'bebas-neue', heldFont: null });
    t.session.setTextOptions({ string: 'II' });
    expect(t.session.updateText().ok).toBe(true);
    expect(fontOfText(t)).toBe(library);
  });

  it('writes a font picked for the edited text once it loads, as one undo step', () => {
    const t = openTestSession(gcs);
    const library = placeAndEdit(t, bebas, 'bebas-neue');
    t.session.setTextOptions({ font: 'lilita-one' });
    expect(fontOfText(t)).toBe(library);
    t.session.setTextFont(font);
    expect(t.session.getState().message).toBeNull();
    expect(fontOfText(t)).not.toBe(library);
    expect(t.editor.store.undoLabel()).toBe('Edit text');
    t.editor.undo();
    expect(fontOfText(t)).toBe(library);
  });

  it('keeps a font the tool does not offer, and names it', () => {
    const t = openTestSession(gcs);
    const library = placeAndEdit(t, custom, 'atkinson-bold');
    expect(t.session.getState().text.heldFont).toBe('A font of my own');
    t.session.setTextOptions({ string: 'II' });
    expect(t.session.updateText().ok).toBe(true);
    expect(fontOfText(t)).toBe(library);
  });
});
