/**
 * Cloud projects on the site's API: opening, autosaving, revisions and
 * restore, with the document's files kept once each by content hash
 * (`cloudAssets.ts`).
 *
 * Three pieces of state are kept per project, all of them facts about the
 * server's copy rather than about one editing session:
 * - the etag of the live document, sent as `If-Match` on every write, so a
 *   save made against a document another tab has moved is refused instead of
 *   silently replacing that tab's work;
 * - the project name as the site last reported it. The document carries a
 *   copy in `metadata.name`; a save sends it to the site only when it differs,
 *   so a tab that never renamed does not put a stale name back over a rename
 *   made on the site;
 * - the asset hashes the server is known to hold, so an autosave uploads a
 *   file once rather than on every save.
 */
import { loadDocument, saveDocument, type Doc } from '@tweakcad/editor';
import { externalizeAssets, internalizeAssets } from './cloudAssets';
import { unusedProjectName } from '../../storage/projectName.ts';

export { CloudConflictError } from '@tweakcad/cloud-providers';

/**
 * The largest file a cloud project takes: each imported file is stored on
 * its own (`putReference`), and the site refuses one past its limit, so a
 * project holding it stops syncing. The site's setting is the rule; this
 * copy only decides when to say so before an import, so it needs no round
 * trip. Should the two differ, the site's refusal at the next save says it.
 */
export const CLOUD_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** The confirmation an import past the cloud's file limit asks for, or null when the file fits. */
export function cloudLimitNotice(fileName: string, bytes: number): { title: string; message: string } | null {
  if (bytes <= CLOUD_FILE_MAX_BYTES) return null;
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return {
    title: 'Too large to sync to the cloud',
    message: `Importing "${fileName}" (${mb(bytes)}) takes this project past the ${mb(CLOUD_FILE_MAX_BYTES)} cloud limit for one file, so it will stop syncing. You can still import it and save to disk. Import anyway?`,
  };
}

/** The site's project API, as `CloudStorageProvider` implements it (or a fake in tests). */
export interface CloudApi {
  /** The account's projects, newest first, one page. */
  list?(): Promise<{ items: { name: string }[] }>;
  create(input: { name: string; tags: string[] }): Promise<{ id: string; slug: string; name: string }>;
  rename(projectId: string, name: string): Promise<unknown>;
  load(projectId: string): Promise<{ project: { name: string }; downloadUrl: string | null; etag: string | null }>;
  loadDocument(projectId: string): Promise<{ text: string; etag: string | null }>;
  save(projectId: string, cadjson: Blob, meta: { ifMatch?: string | null }): Promise<{ etag: string; savedAt: string }>;
  createVersion(
    projectId: string,
    meta: { message?: string; thumbnail?: Blob | null },
  ): Promise<{ versionId: string; createdAt: string }>;
  listRevisions(
    projectId: string,
    opts: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<{ items: CloudRevision[]; nextCursor: string | null }>;
  revisionUrl(projectId: string, revisionId: string): Promise<string>;
  restoreRevision(
    projectId: string,
    revisionId: string,
    opts: { ifMatch?: string | null },
  ): Promise<{ etag: string; snapshotVersionId: string }>;
  putReference(projectId: string, hash: string, body: Uint8Array): Promise<void>;
  referenceUrl(projectId: string, hash: string): Promise<string>;
}

export interface CloudRevision {
  versionId: string;
  createdAt: string;
  message: string | null;
  sizeBytes: number;
  authorId: string | null;
}

/** A signed bucket URL's body. The bucket is another origin: no cookies go with it. */
export interface UrlReader {
  bytes(url: string): Promise<Uint8Array>;
  text(url: string): Promise<string>;
}

export const fetchUrls: UrlReader = {
  async bytes(url) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`The file could not be read (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async text(url) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`The revision could not be read (${res.status}).`);
    return res.text();
  },
};

/** An opened cloud project. `doc` is null when the project has no document yet. */
export interface CloudOpened {
  name: string;
  doc: Doc | null;
  /** Names of files the document uses that could not be fetched. */
  missing: string[];
}

/** A cloud document the app does not open: the reader's plain message. */
export class CloudDocumentError extends Error {}

/** A provider error's message without its leading code (`not_found: ...`). */
export function plainMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z_]+: /, '');
}

export class CloudProjects {
  private readonly etags = new Map<string, string>();
  private readonly names = new Map<string, string>();
  private readonly stored = new Map<string, Set<string>>();

  constructor(
    private readonly api: CloudApi,
    private readonly urls: UrlReader = fetchUrls,
    /** A thumbnail of the view for a new revision, or null without one. */
    private readonly thumbnail: () => Promise<Blob | null> = () => Promise.resolve(null),
  ) {}

  private storedAssets(projectId: string): Set<string> {
    let set = this.stored.get(projectId);
    if (!set) this.stored.set(projectId, (set = new Set()));
    return set;
  }

  /**
   * A generated name for a new project that none of the account's projects
   * (the newest page of them) has; a generated one whatever they hold when
   * they cannot be listed.
   */
  async freshName(): Promise<string> {
    let taken: string[] = [];
    try {
      taken = ((await this.api.list?.())?.items ?? []).map((p) => p.name);
    } catch {
      // A name that repeats one is still a name.
    }
    return unusedProjectName(taken);
  }

  /** Creates an empty project; its name is recorded as the site's, so the first save does not send it back. */
  async create(name: string): Promise<{ id: string; slug: string; name: string }> {
    try {
      const created = await this.api.create({ name, tags: [] });
      this.names.set(created.id, created.name);
      return created;
    } catch (err) {
      throw new Error(plainMessage(err), { cause: err });
    }
  }

  /** Parses a stored document and fetches its external files back in. */
  private async read(projectId: string, text: string): Promise<{ doc: Doc; missing: string[] }> {
    const loaded = loadDocument(text);
    if (!loaded.ok) throw new CloudDocumentError(loaded.message);
    const known = this.storedAssets(projectId);
    const result = await internalizeAssets(loaded.document, async (hash) =>
      this.urls.bytes(await this.api.referenceUrl(projectId, hash)),
    );
    // Fetching a file proves the server holds it, so the next save skips it.
    for (const hash of result.fetched) known.add(hash);
    return { doc: result.doc, missing: result.missing };
  }

  /**
   * The project's live document, with the site's name in `metadata.name` (a
   * rename made on the site shows on the next open). Records the etag the
   * next save states it replaces.
   */
  async open(projectId: string): Promise<CloudOpened> {
    const project = await this.api.load(projectId);
    const name = project.project.name;
    this.names.set(projectId, name);
    if (!project.downloadUrl) {
      if (project.etag) this.etags.set(projectId, project.etag);
      return { name, doc: null, missing: [] };
    }
    const { text, etag } = await this.api.loadDocument(projectId);
    const live = etag ?? project.etag;
    if (live) this.etags.set(projectId, live);
    else this.etags.delete(projectId);
    const { doc, missing } = await this.read(projectId, text);
    const metadata = doc.metadata as Record<string, unknown>;
    return { name, doc: metadata.name === name ? doc : { ...doc, metadata: { ...metadata, name } }, missing };
  }

  /**
   * Writes the live document; creates no revision (`createVersion` does).
   * Files go first, so the server never holds a document naming bytes it has
   * not got. Throws `CloudConflictError` when the project moved under this
   * tab; that is not retried, since retrying is how the other tab's work
   * would be lost.
   */
  async save(projectId: string, doc: Doc): Promise<{ etag: string; savedAt: string }> {
    const { doc: stored, uploads } = externalizeAssets(doc);
    const known = this.storedAssets(projectId);
    // One at a time: the server checks the account's allowance per upload, and parallel uploads could each pass it.
    for (const upload of uploads) {
      if (known.has(upload.hash)) continue;
      await this.api.putReference(projectId, upload.hash, upload.bytes);
      known.add(upload.hash);
    }
    const blob = new Blob([saveDocument(stored)], { type: 'application/json' });
    const result = await this.api.save(projectId, blob, { ifMatch: this.etags.get(projectId) ?? null });
    this.etags.set(projectId, result.etag);
    await this.syncName(projectId, (doc.metadata as { name?: unknown }).name);
    return result;
  }

  /**
   * Sends the document's name to the site when it was renamed here. Never
   * fails the save: a network failure leaves the name to send next time; a
   * refusal (a name the site's policy blocks) is recorded as sent so it is
   * not retried on every save.
   */
  private async syncName(projectId: string, name: unknown): Promise<void> {
    if (typeof name !== 'string' || this.names.get(projectId) === name) return;
    try {
      await this.api.rename(projectId, name);
      this.names.set(projectId, name);
    } catch (err) {
      if ((err as { code?: unknown }).code !== undefined) this.names.set(projectId, name);
      console.warn(`[cloud] The project could not be renamed to "${name}"`, err);
    }
  }

  /** Forgets the etag, so the next save is unconditional (after the user chose to overwrite). */
  forgetEtag(projectId: string): void {
    this.etags.delete(projectId);
  }

  /**
   * Mints a revision of the server's live document, with a thumbnail of the
   * view when there is one; `thumbnail: false` when the view shows another
   * document.
   */
  async createVersion(
    projectId: string,
    message?: string,
    options: { thumbnail?: boolean } = {},
  ): Promise<{ versionId: string; createdAt: string }> {
    const thumbnail = options.thumbnail === false ? null : await this.thumbnail().catch(() => null);
    return this.api.createVersion(projectId, { ...(message ? { message } : {}), thumbnail });
  }

  listRevisions(projectId: string, cursor?: string): Promise<{ items: CloudRevision[]; nextCursor: string | null }> {
    return this.api.listRevisions(projectId, cursor ? { cursor } : {});
  }

  /** One revision's document, read like any document the app opens. */
  async openRevision(projectId: string, revisionId: string): Promise<{ doc: Doc; missing: string[] }> {
    const text = await this.urls.text(await this.api.revisionUrl(projectId, revisionId));
    return this.read(projectId, text);
  }

  /**
   * Makes a revision the live document, and takes the etag the server hands
   * back: the cached one is stale the moment the restore lands, and the next
   * autosave would conflict right after the user fixed their work.
   */
  async restoreRevision(projectId: string, revisionId: string): Promise<{ snapshotVersionId: string }> {
    const result = await this.api.restoreRevision(projectId, revisionId, {
      ifMatch: this.etags.get(projectId) ?? null,
    });
    this.etags.set(projectId, result.etag);
    return { snapshotVersionId: result.snapshotVersionId };
  }
}
