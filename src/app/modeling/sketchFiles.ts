/**
 * DXF and SVG for sketches: inserting a drawing's curves into the sketch
 * being edited (Insert DXF and Insert SVG), importing one as a new sketch on
 * a plane the user picks (File > Import), and exporting a sketch's curves
 * from the browser's menu (Export DXF, Export SVG).
 */
import { enqueueToast } from '../../components/toastStore.ts';
import type { CommandResult } from '@tweakcad/editor';
import { loadSketchSolver, readDrawing, sketchDrawing, type DrawingFormat, type SketchSession } from '../../sketcher';
import { RowMaker } from '../../sketcher/rows';
import { consoleLog } from '../console';
import { partOfFeature } from '../features';
import type { AppServices } from '../services';
import { download } from '../storage/disk';

const TYPES: Record<DrawingFormat, { accept: string; media: string; title: string }> = {
  dxf: { accept: '.dxf,image/vnd.dxf', media: 'image/vnd.dxf', title: 'DXF' },
  svg: { accept: '.svg,image/svg+xml', media: 'image/svg+xml', title: 'SVG' },
};

/** A text file the user picks; nothing happens when they cancel. */
function pickText(accept: string, then: (text: string, name: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    file.text().then(
      (text) => then(text, file.name),
      (e: unknown) =>
        enqueueToast({
          tone: 'warning',
          title: 'Open file',
          message: `${file.name} cannot be read: ${e instanceof Error ? e.message : String(e)}`,
        }),
    );
  });
  document.body.appendChild(input);
  input.click();
}

/** Asks for a DXF or SVG file and inserts its curves into the sketch, as one undo step. */
export function insertDrawing(session: SketchSession, format: DrawingFormat): void {
  pickText(TYPES[format].accept, (text, name) =>
    reportInsert(session.insertDrawing(text, format), format, name, 'Insert'),
  );
}

function reportInsert(result: CommandResult, format: DrawingFormat, name: string, verb: 'Insert' | 'Import'): void {
  const title = `${verb} ${TYPES[format].title}`;
  if (!result.ok) enqueueToast({ tone: 'warning', title, message: result.error.message });
  else enqueueToast({ tone: 'success', title, message: `${name} is in the sketch` });
}

/** A drawing read from a file, waiting for its new sketch: unbound while the plane is picked, then bound to the sketch made. */
let pending: { text: string; format: DrawingFormat; name: string; feature: string | null } | null = null;

/**
 * File > Import DXF or SVG (sketch): asks for the file, checks it holds
 * curves a sketch can take, then asks for a plane. The sketch made on it
 * opens with the drawing's curves in it ({@link takePendingDrawing}).
 */
export function importDrawingSketch(services: AppServices, format: DrawingFormat): void {
  const { title } = TYPES[format];
  if (services.app.getState().mode.kind === 'sketch') {
    const message = `Finish the sketch before importing a ${title}`;
    consoleLog('warn', message, 'sketch');
    enqueueToast({ tone: 'warning', title: `Import ${title}`, message });
    return;
  }
  pickText(TYPES[format].accept, (text, name) => void acceptDrawing(services, format, text, name));
}

/** Holds a drawing read from a file for the sketch the plane picker will make; refused when it has nothing a sketch can take. */
export function acceptDrawing(
  services: Pick<AppServices, 'app'>,
  format: DrawingFormat,
  text: string,
  name: string,
): boolean {
  const { title } = TYPES[format];
  let n = 0;
  const read = readDrawing(text, format, new RowMaker((kind) => `${kind}_check${n++}`));
  if (!read.ok) {
    consoleLog('warn', `${title} "${name}": ${read.message}`, 'sketch');
    enqueueToast({ tone: 'warning', title: `Import ${title}`, message: read.message });
    return false;
  }
  if (read.drawing.skipped.length > 0)
    consoleLog('warn', `${title}: skipped ${read.drawing.skipped.join(', ')}`, 'sketch');
  pending = { text, format, name, feature: null };
  consoleLog(
    'info',
    `${title} "${name}": ${read.drawing.change.add?.curves?.length ?? 0} curve(s). Pick a plane`,
    'sketch',
  );
  services.app.setState({ panel: { kind: 'sketchPlane' } });
  return true;
}

/** Binds the drawing waiting for a plane to the sketch just made for it. */
export function bindPendingDrawing(feature: string): void {
  if (pending && pending.feature === null) pending = { ...pending, feature };
}

/** Drops a drawing still waiting for a plane: the plane picker closed without one. */
export function dropPendingDrawing(): void {
  if (pending?.feature === null) pending = null;
}

/** Inserts the drawing waiting for the sketch `session` edits, if one is; as its own undo step after the new sketch. */
export function takePendingDrawing(session: Pick<SketchSession, 'insertDrawing'>, feature: string): void {
  if (!pending || pending.feature !== feature) return;
  const { text, format, name } = pending;
  pending = null;
  reportInsert(session.insertDrawing(text, format), format, name, 'Import');
}

/** Downloads a sketch's curves as a DXF or SVG drawing, as the document's values solve them when asked. */
export async function exportDrawing(services: AppServices, feature: string, format: DrawingFormat): Promise<void> {
  const doc = services.editor.document;
  const part = partOfFeature(doc, feature);
  if (!part) return;
  const display = services.display.getState().display;
  const index = display?.parts[part];
  const externals =
    (index === undefined ? undefined : display?.definitions[index])?.sketches.find((s) => s.feature === feature)
      ?.externals ?? [];
  const drawing = sketchDrawing(doc, part, feature, format, await loadSketchSolver(), externals);
  if (!drawing.ok) {
    const title = `Export ${TYPES[format].title}`;
    consoleLog('warn', `${title}: ${drawing.message}`, 'sketch');
    enqueueToast({ tone: 'warning', title, message: drawing.message });
    return;
  }
  const name = featureName(doc, part, feature) ?? 'sketch';
  download(`${name.replace(/[\\/:*?"<>|]+/g, '_')}.${format}`, new Blob([drawing.text], { type: TYPES[format].media }));
}

function featureName(doc: AppServices['editor']['document'], part: string, feature: string): string | undefined {
  const parts = Array.isArray(doc.parts) ? (doc.parts as Record<string, unknown>[]) : [];
  const timeline = (parts.find((p) => p.id === part)?.timeline as Record<string, unknown>[] | undefined) ?? [];
  const find = (rows: Record<string, unknown>[]): Record<string, unknown> | undefined => {
    for (const r of rows) {
      if (r.id === feature) return r;
      if (Array.isArray(r.children)) {
        const inner = find(r.children as Record<string, unknown>[]);
        if (inner) return inner;
      }
    }
    return undefined;
  };
  const name = find(timeline)?.name;
  return typeof name === 'string' ? name : undefined;
}
