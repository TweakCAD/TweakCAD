/**
 * Disk file I/O for .cadjson documents.
 *
 * Two paths:
 *
 *   File System Access API (Chromium, Edge, recent Firefox):
 *     `showOpenFilePicker` / `showSaveFilePicker` return a
 *     `FileSystemFileHandle`. We keep that handle in DocumentStorage and
 *     subsequent saves write back to the same file silently (after one
 *     permission grant per session). This is the desktop-app-like UX.
 *
 *   Fallback (Safari, older browsers):
 *     `<input type="file">` for Open, and a synthetic download via
 *     `URL.createObjectURL` for Save. Every save triggers a browser
 *     download — the user accumulates `foo (1).cadjson`, `foo (2).cadjson`
 *     in Downloads/ unless they manually overwrite. Less smooth but works
 *     everywhere.
 *
 * The two paths return the same `OpenResult` / write the same bytes, so
 * the rest of the codebase doesn't branch on which it is — it just stores
 * `handle: null` when the API isn't available and re-prompts for a path
 * on every Save in that case (handled by the fileOps layer).
 */
import type { CadProject } from '@tweakcad/core/src/document/schema.ts';
import { loadCadDocumentOrThrow } from '@tweakcad/core/src/document/loader.ts';
import { hashComponentSource } from '@tweakcad/core/src/document/contentHash.ts';

const FILE_TYPES: FilePickerAcceptType[] = [
  {
    description: 'CAD document (.cadjson)',
    accept: { 'application/json': ['.cadjson'] },
  },
];

/**
 * Geometry import accepts only the formats our kernel can read.
 * Kept separate from FILE_TYPES so the project-open picker stays
 * focused on .cadjson and doesn't dilute its file-type filter.
 */
const IMPORT_TYPES: FilePickerAcceptType[] = [
  {
    description: 'STEP file (.step / .stp)',
    accept: { 'model/step': ['.step', '.stp'] },
  },
  {
    description: 'STL mesh (.stl)',
    accept: { 'model/stl': ['.stl'] },
  },
  {
    description: 'BREP file (.brep / .brp)',
    accept: { 'model/brep': ['.brep', '.brp'] },
  },
];

/**
 * DXF sketch-import accepts only .dxf. Kept separate from IMPORT_TYPES
 * (the 3D STEP/STL/BREP body import) because DXF routes to the
 * sketch-import flow — it becomes 2D sketch geometry on a chosen plane,
 * never an `importedGeometry` body. DXF is ASCII, so we read it as text.
 */
const DXF_IMPORT_TYPES: FilePickerAcceptType[] = [
  {
    description: 'DXF drawing (.dxf)',
    accept: { 'image/vnd.dxf': ['.dxf'] },
  },
];

const SVG_IMPORT_TYPES: FilePickerAcceptType[] = [
  {
    description: 'SVG drawing (.svg)',
    accept: { 'image/svg+xml': ['.svg'] },
  },
];

/**
 * FreeCAD `.fcstd` import accepts only .fcstd. A .fcstd is a binary ZIP
 * archive carrying a whole parametric document (Sketch/Pad/Pocket tree), so
 * it opens as a new document rather than embedding as a body — kept separate
 * from IMPORT_TYPES (3D body geometry) for that reason.
 */
const FCSTD_IMPORT_TYPES: FilePickerAcceptType[] = [
  {
    description: 'FreeCAD document (.fcstd)',
    accept: { 'application/x-extension-fcstd': ['.fcstd', '.FCStd'] },
  },
];

/**
 * Component import accepts .cadcomponent (the convention) plus .cadjson
 * (since a .cadcomponent IS just a .cadjson with one part and at least
 * one public parameter). Separate filter so the user can't accidentally
 * pick a STEP/STL geometry file thinking it's a parametric component.
 */
const COMPONENT_IMPORT_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Parametric component (.cadcomponent)',
    accept: { 'application/json': ['.cadcomponent'] },
  },
  {
    description: 'CAD document used as component (.cadjson)',
    accept: { 'application/json': ['.cadjson'] },
  },
];

/**
 * Result of an import-geometry file pick: enough to dispatch a
 * CreateImportedGeometry command without further IO.
 */
export type ImportPickResult = {
  fileName: string;
  format: 'step' | 'stl' | 'brep';
  /** Base64-encoded file bytes, ready for embedding into the feature inputs. */
  dataBase64: string;
};

/**
 * Result of a parametric-component file pick: a parsed CadProject ready
 * to be wrapped in a ComponentDefinition and embedded into the host
 * project. The hash is pre-computed so the calling layer can dedupe
 * before dispatching the CreateComponent command (and pin the
 * exact-version the host is built against).
 */
export type ComponentImportPickResult = {
  fileName: string;
  /** Parsed sub-document. Same CadProject shape as the host. */
  source: CadProject;
  /** SHA-256 (hex) of canonical-JSON serialization of `source`. */
  hash: string;
};

export type OpenResult = {
  doc: CadProject;
  handle: FileSystemFileHandle | null;
  filename: string;
};

/** True if the modern File System Access API is available. */
export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

// --- Shared import-file picker -------------------------------------------

/**
 * Open-file-picker plumbing shared by every import flow: tries the File
 * System Access API and falls back to a hidden `<input>`, mapping the chosen
 * File through `read`. Returns null when the user cancels. Each typed picker
 * (geometry, sketch text, component, `.fcstd`) is a thin wrapper that differs
 * only in the accepted types and how the File is decoded.
 *
 * The `.cadjson` Open path (`openFileFromDisk`) deliberately does NOT use
 * this — it keeps the `FileSystemFileHandle` for later Save-back, a contract
 * the import pickers don't share.
 */
async function pickImportFile<T>(opts: {
  types: FilePickerAcceptType[];
  accept: string;
  read: (file: File) => Promise<T>;
}): Promise<T | null> {
  if (isFileSystemAccessSupported()) {
    return pickViaFSA(opts.types, opts.read);
  }
  return pickViaInput(opts.accept, opts.read);
}

async function pickViaFSA<T>(
  types: FilePickerAcceptType[],
  read: (file: File) => Promise<T>,
): Promise<T | null> {
  const picker = window.showOpenFilePicker!;
  try {
    const [handle] = await picker({ multiple: false, types, excludeAcceptAllOption: false });
    if (!handle) return null;
    return await read(await handle.getFile());
  } catch (err) {
    // AbortError = user cancelled the picker.
    if ((err as DOMException)?.name === 'AbortError') return null;
    throw err;
  }
}

function pickViaInput<T>(
  accept: string,
  read: (file: File) => Promise<T>,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';

    // The picker is modal but doesn't fire a reliable 'cancel' event across
    // browsers; detect cancellation via a change event with no files plus a
    // window-focus heuristic.
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      input.remove();
      window.removeEventListener('focus', onFocus);
    };
    const onFocus = () => {
      setTimeout(() => {
        if (resolved) return;
        if (!input.files || input.files.length === 0) { cleanup(); resolve(null); }
      }, 200);
    };

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { cleanup(); resolve(null); return; }
      try {
        const result = await read(file);
        cleanup();
        resolve(result);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    document.body.appendChild(input);
    window.addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}

// --- Open ----------------------------------------------------------------

/**
 * Prompt the user to open a .cadjson from disk. Returns null if the user
 * cancels the picker.
 */
export async function openFileFromDisk(): Promise<OpenResult | null> {
  if (isFileSystemAccessSupported()) {
    return openViaFSA();
  }
  return openViaInput();
}

async function openViaFSA(): Promise<OpenResult | null> {
  // isFileSystemAccessSupported() gated this call; the `!` is sound.
  const picker = window.showOpenFilePicker!;
  try {
    const [handle] = await picker({
      multiple: false,
      types: FILE_TYPES,
      excludeAcceptAllOption: false,
    });
    if (!handle) return null;
    const file = await handle.getFile();
    const text = await file.text();
    const doc = parseCadJson(text);
    return { doc, handle, filename: file.name };
  } catch (err) {
    // AbortError = user cancelled the picker.
    if ((err as DOMException)?.name === 'AbortError') return null;
    throw err;
  }
}

function openViaInput(): Promise<OpenResult | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cadjson,application/json';
    input.style.display = 'none';

    // The picker is modal but doesn't fire a 'cancel' event reliably across
    // browsers; we detect cancellation by checking the change event with no
    // files, plus a window-focus heuristic.
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      input.remove();
      window.removeEventListener('focus', onFocus);
    };
    const onFocus = () => {
      // Give the change event one tick to fire before assuming cancel.
      setTimeout(() => {
        if (resolved) return;
        if (!input.files || input.files.length === 0) {
          cleanup();
          resolve(null);
        }
      }, 200);
    };

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(null);
        return;
      }
      try {
        const text = await file.text();
        const doc = parseCadJson(text);
        cleanup();
        resolve({ doc, handle: null, filename: file.name });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    document.body.appendChild(input);
    window.addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}

// --- Import Geometry (STEP / STL / BREP) --------------------------------

/**
 * Prompt the user for a STEP, STL, or BREP file and return its bytes ready
 * for embedding into an `importedGeometry` feature. The format is
 * inferred from the extension (case-insensitive). Returns null if the
 * user cancels.
 *
 * The optional `format` hint narrows the picker's file-type filter
 * to just that format — useful when the caller already knows what
 * the user picked (e.g. an "Import STEP…" dropdown item). Omitted
 * → both formats accepted.
 *
 * Kept here (next to `openFileFromDisk`) so all file-picker code lives
 * in one place — the calling layer (App.tsx) just dispatches the
 * CreateImportedGeometry command with the result.
 */
export function pickGeometryForImport(
  format?: 'step' | 'stl' | 'brep',
): Promise<ImportPickResult | null> {
  return pickImportFile({
    types: pickerTypesFor(format),
    accept: inputAcceptFor(format),
    read: fileToImportResult,
  });
}

/**
 * FilePickerAcceptType[] narrowed to the requested format, or the
 * full IMPORT_TYPES when no hint is given. Keeps the unified picker
 * available for legacy callers while letting dropdown items focus
 * the picker on a single format.
 */
function pickerTypesFor(format?: 'step' | 'stl' | 'brep'): FilePickerAcceptType[] {
  if (format === 'step') {
    return IMPORT_TYPES.filter(t => t.description?.startsWith('STEP'));
  }
  if (format === 'stl') {
    return IMPORT_TYPES.filter(t => t.description?.startsWith('STL'));
  }
  if (format === 'brep') {
    return IMPORT_TYPES.filter(t => t.description?.startsWith('BREP'));
  }
  return IMPORT_TYPES;
}

/** Plain <input accept=…> string for the input-element fallback path. */
function inputAcceptFor(format?: 'step' | 'stl' | 'brep'): string {
  if (format === 'step') return '.step,.stp,model/step';
  if (format === 'stl') return '.stl,model/stl';
  if (format === 'brep') return '.brep,.brp,model/brep';
  return '.step,.stp,.stl,.brep,.brp,model/step,model/stl,model/brep';
}

/**
 * Read a File → ArrayBuffer → base64 string. The format is inferred
 * from the filename extension; .stp normalizes to 'step' (.stp is
 * the legacy short extension, identical content). Throws if the
 * extension isn't a recognized import format.
 */
async function fileToImportResult(file: File): Promise<ImportPickResult> {
  const name = file.name;
  const lower = name.toLowerCase();
  let format: 'step' | 'stl' | 'brep';
  if (lower.endsWith('.step') || lower.endsWith('.stp')) {
    format = 'step';
  } else if (lower.endsWith('.stl')) {
    format = 'stl';
  } else if (lower.endsWith('.brep') || lower.endsWith('.brp')) {
    format = 'brep';
  } else {
    throw new Error(`Unrecognized import format for "${name}". Expected .step / .stp / .stl / .brep / .brp.`);
  }
  const buf = await file.arrayBuffer();
  return { fileName: name, format, dataBase64: arrayBufferToBase64(buf) };
}

/**
 * Binary ArrayBuffer → base64 string. btoa is sync + handles 8-bit
 * cleanly when fed via String.fromCharCode chunks. Chunking avoids
 * "Maximum call stack" on very large files.
 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

// --- Import DXF / SVG as sketch (text) ----------------------------------

/**
 * Result of a 2D sketch-import file pick: the file name and the raw text.
 * DXF and SVG are both text formats, so unlike STEP/STL/BREP (binary →
 * base64) we read them as text and hand them straight to the matching
 * `parseDxf` / `parseSvg` reader.
 */
export type SketchTextImportResult = {
  fileName: string;
  /** Raw file content (DXF ASCII or SVG XML). */
  text: string;
};

/**
 * Prompt for a `.dxf` file and return its text, ready for `parseDxf`.
 * Returns null if the user cancels. Routes to the SKETCH import flow
 * (2D geometry on a chosen plane), never the 3D body import.
 */
export function pickDxfForImport(): Promise<SketchTextImportResult | null> {
  return pickImportFile({ types: DXF_IMPORT_TYPES, accept: '.dxf,image/vnd.dxf', read: readAsSketchText });
}

/** Prompt for a `.svg` file and return its text, ready for `parseSvg`. */
export function pickSvgForImport(): Promise<SketchTextImportResult | null> {
  return pickImportFile({ types: SVG_IMPORT_TYPES, accept: '.svg,image/svg+xml', read: readAsSketchText });
}

async function readAsSketchText(file: File): Promise<SketchTextImportResult> {
  return { fileName: file.name, text: await file.text() };
}

// --- Import FreeCAD (.fcstd) --------------------------------------------

/**
 * Result of a `.fcstd` file pick: the file name and the raw archive bytes.
 * A `.fcstd` is a binary ZIP archive (like STEP/STL/BREP it's read as bytes,
 * not text), but it carries a whole parametric document, so it routes to the
 * OPEN flow (`importFcstdAsDocument`) — replacing the active document — not
 * the `importedGeometry` body flow.
 */
export type FcstdImportPickResult = {
  fileName: string;
  /** Raw `.fcstd` bytes (a ZIP archive), ready for `importFcstd`. */
  bytes: Uint8Array;
};

/**
 * Prompt for a `.fcstd` (FreeCAD) file and return its raw bytes, ready for
 * `importFcstd`. Returns null if the user cancels.
 */
export function pickFcstdForImport(): Promise<FcstdImportPickResult | null> {
  return pickImportFile({
    types: FCSTD_IMPORT_TYPES,
    accept: '.fcstd,application/x-extension-fcstd',
    read: async (file) => ({ fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }),
  });
}

// --- Import Component (.cadcomponent / .cadjson) -------------------------

/**
 * Prompt the user for a `.cadcomponent` (or `.cadjson` used as one) and
 * return its parsed CadProject + content hash, ready for the App layer
 * to dispatch a `CreateComponent` command.
 *
 * Hashing happens HERE rather than in the command handler so:
 *   1. The expensive Web Crypto digest only runs at pick time (not on
 *      every command-dispatch / undo / redo cycle).
 *   2. The caller can dedupe against existing `embeddedComponents`
 *      entries before dispatch — show "Already embedded — using
 *      existing entry" instead of overwriting.
 *
 * Errors during pick / parse propagate; callers should `try / catch`
 * and surface a user-visible message.
 */
export function pickComponentForImport(): Promise<ComponentImportPickResult | null> {
  return pickImportFile({
    types: COMPONENT_IMPORT_TYPES,
    accept: '.cadcomponent,.cadjson,application/json',
    read: fileToComponentResult,
  });
}

/**
 * Read a File → parsed CadProject + SHA-256 hash. The hash is computed
 * over the canonical-JSON form (sorted keys, no whitespace) of the
 * parsed object — not the raw on-disk bytes — so two files with the
 * same content but different formatting collapse to the same hash.
 *
 * Throws on:
 *   - non-JSON content
 *   - missing parts (a component with no parts can't be instanced)
 *   - parse failures
 */
async function fileToComponentResult(file: File): Promise<ComponentImportPickResult> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`"${file.name}" is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`"${file.name}" is not a CAD document.`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj.metadata || !obj.parts || !obj.parameters) {
    throw new Error(`"${file.name}" doesn't look like a .cadjson / .cadcomponent.`);
  }
  const parts = obj.parts as Record<string, unknown>;
  if (Object.keys(parts).length === 0) {
    throw new Error(`"${file.name}" has no parts, so there is nothing to instance as a component.`);
  }

  const source = parsed as CadProject;
  const hash = await hashComponentSource(source);
  return { fileName: file.name, source, hash };
}


// --- Save ----------------------------------------------------------------

export type SaveResult = {
  handle: FileSystemFileHandle | null;
  filename: string;
  savedAt: number;
};

/**
 * Write back to a known handle. Used for Ctrl+S after the user opened or
 * saved-as'd a disk-backed doc.
 */
export async function writeToHandle(
  handle: FileSystemFileHandle,
  doc: CadProject,
): Promise<SaveResult> {
  // Re-grant permission silently if we already have it, otherwise prompt.
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    const next = await handle.requestPermission({ mode: 'readwrite' });
    if (next !== 'granted') {
      throw new Error('Permission to write the file was denied.');
    }
  }

  const writable = await handle.createWritable();
  try {
    await writable.write(serialize(doc));
  } finally {
    await writable.close();
  }
  return { handle, filename: handle.name, savedAt: Date.now() };
}

/**
 * Prompt the user for a destination file and write. Returns null if the
 * user cancels the picker.
 */
export async function saveFileAs(
  doc: CadProject,
  suggestedName: string,
): Promise<SaveResult | null> {
  if (isFileSystemAccessSupported()) {
    return saveAsViaFSA(doc, suggestedName);
  }
  return saveAsViaDownload(doc, suggestedName);
}

async function saveAsViaFSA(
  doc: CadProject,
  suggestedName: string,
): Promise<SaveResult | null> {
  const picker = window.showSaveFilePicker!;
  try {
    const handle = await picker({
      suggestedName,
      types: FILE_TYPES,
      excludeAcceptAllOption: false,
    });
    return await writeToHandle(handle, doc);
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return null;
    throw err;
  }
}

function saveAsViaDownload(
  doc: CadProject,
  suggestedName: string,
): Promise<SaveResult> {
  // Synthetic download — Safari & older Firefox fallback. The user picks
  // the path via the browser's Save dialog (or it lands in Downloads
  // directly, depending on browser settings). We can't get the chosen
  // path back, so subsequent Ctrl+S will keep re-prompting.
  const blob = new Blob([serialize(doc)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a short delay so the click handler has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return Promise.resolve({ handle: null, filename: suggestedName, savedAt: Date.now() });
}

// --- Text export (DXF / SVG) ---------------------------------------------

/**
 * Download an in-memory text string as a file via a synthetic anchor click.
 * Used by the 2D sketch exporters (DXF / SVG) — these have no on-disk
 * handle to write back to, so they always go through the download path
 * (mirrors `saveAsViaDownload`). `URL.createObjectURL` + click works in
 * every browser, including those without the File System Access API.
 */
export function downloadText(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

// --- Helpers -------------------------------------------------------------

function serialize(doc: CadProject): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * Validate a `.cadjson` read from disk.
 *
 * This used to be a three-magic-key check followed by a cast, with a comment
 * saying full validation "belongs in a future loader hook". That hook now
 * exists and this delegates to it. The name is kept local because both call
 * sites above expect a throw rather than a Result.
 *
 * Note it shadowed `parseCadJson` in `@tweakcad/core/src/document/serialization.ts`
 * — the real validating parser — which is why nobody noticed disk loads were
 * unvalidated for so long. That core function is now gone; `loadCadDocument`
 * replaces it.
 */
function parseCadJson(text: string): CadProject {
  const loaded = loadCadDocumentOrThrow(text);
  // Diagnostics mean the document opened with features this build cannot
  // rebuild. They are logged rather than thrown: the rest of the document is
  // still the user's work. Surfacing them in the UI is the follow-up.
  for (const d of loaded.diagnostics) {
    console.warn(`[open] ${d.message}`);
  }
  return loaded.project;
}
