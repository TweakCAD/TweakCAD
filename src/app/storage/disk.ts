/**
 * `.cadjson` files on the user's disk.
 *
 * With the File System Access API (Chromium, Edge) a picked file keeps its
 * handle, so Save writes back to the same file after one permission grant.
 * Elsewhere Open falls back to an `<input type="file">` and Save to a
 * download, so every save asks where to put the file.
 *
 * Documents are read and written as text; parsing and checking is the
 * caller's (`loadDocument`).
 */

const FILE_TYPES: FilePickerAcceptType[] = [
  { description: 'CAD document (.cadjson)', accept: { 'application/json': ['.cadjson'] } },
];

export interface OpenedFile {
  text: string;
  handle: FileSystemFileHandle | null;
  filename: string;
}

export interface SavedFile {
  handle: FileSystemFileHandle | null;
  filename: string;
}

function isAbort(err: unknown): boolean {
  return (err as DOMException | undefined)?.name === 'AbortError';
}

/** Asks for a `.cadjson` file; null when the user cancels. */
export async function openFileFromDisk(): Promise<OpenedFile | null> {
  const picker = typeof window === 'undefined' ? undefined : window.showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker.call(window, { multiple: false, types: FILE_TYPES, excludeAcceptAllOption: false });
      if (!handle) return null;
      const file = await handle.getFile();
      return { text: await file.text(), handle, filename: file.name };
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  const file = await pickWithInput('.cadjson,application/json');
  return file && { text: await file.text(), handle: null, filename: file.name };
}

/**
 * The file an `<input type="file">` returns, or null on cancel. Browsers fire
 * no reliable cancel event, so a window focus with no file chosen counts as
 * one.
 */
export function pickWithInput(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let done = false;
    const finish = (file: File | null) => {
      if (done) return;
      done = true;
      input.remove();
      window.removeEventListener('focus', onFocus);
      resolve(file);
    };
    const onFocus = () => {
      setTimeout(() => {
        if (!input.files || input.files.length === 0) finish(null);
      }, 200);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    document.body.appendChild(input);
    window.addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}

/** Writes `text` back to a file the user picked earlier, asking for permission again if needed. */
export async function writeToHandle(handle: FileSystemFileHandle, text: string): Promise<SavedFile> {
  if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      throw new Error('Permission to write the file was denied.');
    }
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
  } finally {
    await writable.close();
  }
  return { handle, filename: handle.name };
}

/** Asks where to save and writes `text` there; null when the user cancels. Without the API, downloads it. */
export async function saveFileAs(text: string, suggestedName: string): Promise<SavedFile | null> {
  const picker = typeof window === 'undefined' ? undefined : window.showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker.call(window, { suggestedName, types: FILE_TYPES, excludeAcceptAllOption: false });
      return await writeToHandle(handle, text);
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  download(suggestedName, new Blob([text], { type: 'application/json' }));
  return { handle: null, filename: suggestedName };
}

/** Starts a browser download of `blob`. */
export function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The click starts the download asynchronously; revoke once it has begun.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** A file name from a document name: safe characters, at most 64 of them. */
export function safeFileName(name: string, extension: string): string {
  const base = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `${base || 'document'}.${extension}`;
}
