/**
 * Asking the user for a file to import: the File System Access picker where
 * the browser has it, an `<input type="file">` elsewhere. The bytes are read
 * whole; parsing is the importer's.
 */
import { pickWithInput } from '../storage/disk';

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

export interface FileKind {
  description: string;
  /** Extensions with their dot, e.g. `.step`. */
  extensions: string[];
  mediaType: string;
}

function isAbort(err: unknown): boolean {
  return (err as DOMException | undefined)?.name === 'AbortError';
}

/** A file of `kind`, or null when the user cancels. */
export async function pickFile(kind: FileKind): Promise<PickedFile | null> {
  const picker = typeof window === 'undefined' ? undefined : window.showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker.call(window, {
        multiple: false,
        types: [{ description: kind.description, accept: { [kind.mediaType]: kind.extensions as `.${string}`[] } }],
        excludeAcceptAllOption: false,
      });
      if (!handle) return null;
      const file = await handle.getFile();
      return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  const file = await pickWithInput(kind.extensions.join(','));
  return file && { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

export const F3D_FILE: FileKind = {
  description: 'Design file (.f3d, .f3z)',
  extensions: ['.f3d', '.f3z'],
  mediaType: 'application/x-f3d',
};

export const FREECAD_FILE: FileKind = {
  description: 'FreeCAD document (.FCStd)',
  extensions: ['.FCStd', '.fcstd'],
  mediaType: 'application/x-freecad',
};
