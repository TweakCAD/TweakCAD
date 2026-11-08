/**
 * A sketch of a document as a DXF or SVG drawing, and a drawing read into
 * rows for a sketch: what the app's export and insert commands use.
 */
import type { GcsWrapper } from '@salusoft89/planegcs';
import type { Doc } from '@tweakcad/editor';
import { SketchGeometry } from '../geometry';
import { sketchInputs, type RowMaker } from '../rows';
import { externalShapes, solveInputs, type ExternalShape } from '../solve';
import { fontsIn, textGlyphs } from '../text';
import { WorkingValues } from '../values';
import { sketchToDxf } from './dxf';
import { importDxf } from './dxfImport';
import type { SketchImport } from './importRows';
import { sketchToSvg } from './svg';
import { importSvg, MAX_SVG_IMPORT_CURVES } from './svgImport';

export type DrawingFormat = 'dxf' | 'svg';

/**
 * The sketch's drawn curves and text outlines as the document's values
 * solve them now (a parameter change moves them before an edit writes the
 * new positions), as a drawing. External curves are written with the shapes
 * evaluation built for them. Refused when the part or sketch is gone, or
 * the sketch does not solve.
 */
export function sketchDrawing(
  doc: Doc,
  part: string,
  feature: string,
  format: DrawingFormat,
  gcs: GcsWrapper,
  externals: readonly ExternalShape[] = [],
): { ok: true; text: string } | { ok: false; message: string } {
  const stored = sketchInputs(doc, part, feature);
  if (!stored) return { ok: false, message: 'That sketch is gone' };
  const values = new WorkingValues(doc);
  const solved = solveInputs(gcs, values, stored, externals);
  if (!solved.ok) return { ok: false, message: solved.message };
  const inputs = solved.inputs;
  const geometry = new SketchGeometry(inputs, values, externalShapes(externals));
  const glyphs = (textGlyphs(inputs, values, fontsIn(doc)) ?? []).map((g) => g.shape);
  return { ok: true, text: format === 'dxf' ? sketchToDxf(geometry, glyphs) : sketchToSvg(geometry, glyphs) };
}

/** A drawing's text read into rows; refused with a plain message when it holds nothing to insert or too much. */
export function readDrawing(
  text: string,
  format: DrawingFormat,
  make: RowMaker,
): { ok: true; drawing: SketchImport } | { ok: false; message: string } {
  let drawing: SketchImport;
  try {
    drawing = format === 'dxf' ? importDxf(text, make) : importSvg(text, make);
  } catch (e) {
    return { ok: false, message: `That file cannot be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const curves = drawing.change.add?.curves?.length ?? 0;
  if (curves === 0)
    return {
      ok: false,
      message: `That file has no curves a sketch can take${drawing.skipped.length > 0 ? ` (it has ${drawing.skipped.join(', ')})` : ''}`,
    };
  if (format === 'svg' && curves > MAX_SVG_IMPORT_CURVES)
    return {
      ok: false,
      message: `That drawing has ${curves} curves; a sketch takes up to ${MAX_SVG_IMPORT_CURVES} from SVG`,
    };
  return { ok: true, drawing };
}
