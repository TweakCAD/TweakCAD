/**
 * Client-side implementation of project storage backed by the cloud API.
 *
 * Used by the CAD app when the user is signed in. The interface defined here
 * mirrors the ProjectStorage contract, but is locally typed to avoid a
 * coupling to a kernel-aware package. Strict ProjectStorage conformance is
 * established when the CAD app wires this in.
 */
import { ApiClient } from '@tweakcad/api-client';
import type {
  CreateProjectRequest} from '@tweakcad/api-types';
import {
  ApiError,
  ProjectSummary,
  Project,
  PageResponse,
  type Page,
} from '@tweakcad/api-types';
import { z } from 'zod';

const ListResponse = PageResponse(ProjectSummary);

const GetResponse = z.object({
  project: ProjectSummary,
  downloadUrl: z.string().nullable(),
  etag: z.string().nullable(),
  sizeBytes: z.number().int(),
});
type GetResponse = z.infer<typeof GetResponse>;

/** `PUT .../document` — autosave. Overwrites the live document; no version. */
const SaveResponse = z.object({
  savedAt: z.string(),
  etag: z.string(),
});
type SaveResponse = z.infer<typeof SaveResponse>;

/** `POST .../revisions` — mints an immutable snapshot of the live document. */
const VersionResponse = z.object({
  versionId: z.string(),
  createdAt: z.string(),
});
type VersionResponse = z.infer<typeof VersionResponse>;

/** One entry in a project's revision history. */
const RevisionSummary = z.object({
  versionId: z.string(),
  createdAt: z.string(),
  message: z.string().nullable(),
  sizeBytes: z.number().int(),
  authorId: z.string().nullable(),
});

const RevisionPage = z.object({
  items: z.array(RevisionSummary),
  nextCursor: z.string().nullable(),
});
type RevisionPage = z.infer<typeof RevisionPage>;

const RevisionUrlResponse = z.object({
  revisionId: z.string(),
  downloadUrl: z.string(),
  expiresInSeconds: z.number().int(),
});

/**
 * `restoredFrom` echoes the revision asked for; `snapshotVersionId` is the
 * revision the server minted of the pre-restore state, so the UI can offer
 * "undo this restore" without inventing one.
 */
const RestoreResponse = z.object({
  etag: z.string(),
  restoredFrom: z.string(),
  snapshotVersionId: z.string(),
});
type RestoreResponse = z.infer<typeof RestoreResponse>;

const PutReferenceResponse = z.object({
  stored: z.boolean(),
  bytes: z.number().int(),
});

const ReferenceUrlResponse = z.object({
  hash: z.string(),
  downloadUrl: z.string(),
  expiresInSeconds: z.number().int(),
});

/** Thrown when `If-Match` fails: the project moved under us. */
export class CloudConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudConflictError';
  }
}

const DeleteResponse = z.object({ ok: z.literal(true) });

export type CloudStorageConfig = {
  baseUrl: string;
  fetch?: typeof fetch;
};

export class CloudStorageProvider {
  readonly id = 'cloud' as const;
  readonly label = 'Cloud Storage';
  private api: ApiClient;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(config: CloudStorageConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.fetchImpl = config.fetch ?? fetch.bind(globalThis);
    this.api = new ApiClient({
      baseUrl: config.baseUrl,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  async list(): Promise<Page<ProjectSummary>> {
    const res = await this.api.request('GET', '/api/v1/projects', ListResponse);
    if (!res.ok) throw apiError(res.error);
    return res.value;
  }

  async create(input: CreateProjectRequest): Promise<ProjectSummary> {
    const res = await this.api.request(
      'POST',
      '/api/v1/projects',
      ProjectSummary,
      input,
    );
    if (!res.ok) throw apiError(res.error);
    return res.value;
  }

  async load(projectId: string): Promise<GetResponse> {
    const res = await this.api.request(
      'GET',
      `/api/v1/projects/${encodeURIComponent(projectId)}`,
      GetResponse,
    );
    if (!res.ok) throw apiError(res.error);
    return res.value;
  }

  /**
   * The live document, parsed but not validated, with the etag of the bytes
   * that were served.
   *
   * Read through the app rather than `downloadUrl`: that is a signed bucket
   * URL on another origin, and a cross-origin `fetch()` of it needs bucket
   * CORS the editor cannot count on. The etag comes from this response, not
   * from {@link load}, so it describes exactly the bytes returned even when
   * an autosave lands between the two requests.
   */
  async loadDocument(projectId: string): Promise<{ document: unknown; etag: string | null }> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/document`,
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'include', cache: 'no-store' },
    );
    if (!response.ok) {
      const raw: unknown = await response.json().catch(() => null);
      const parsed = ApiError.safeParse(raw);
      throw apiError(
        parsed.success
          ? parsed.data
          : { code: 'internal', message: `Document request failed (${response.status})` },
      );
    }
    return { document: await response.json(), etag: response.headers.get('etag') };
  }

  /**
   * Autosave: overwrite the live document. Creates **no** version — call
   * {@link createVersion} for that. The two were one call until the
   * autosave/versioning split; collapsing them meant a 2-second debounce
   * minted a permanent R2 object, a row and a thumbnail per keystroke burst.
   *
   * @param ifMatch The etag from the last load or save. When supplied, the
   *   server rejects the write if the project moved in the meantime, which
   *   is the only thing stopping two tabs from silently overwriting each
   *   other. Omit it only when there is genuinely nothing to compare against.
   */
  async save(
    projectId: string,
    cadjson: Blob | File,
    meta: { ifMatch?: string | null } = {},
  ): Promise<SaveResponse> {
    const form = new FormData();
    form.append('cadjson', cadjson, 'document.cadjson');
    const res = await this.api.request(
      'PUT',
      `/api/v1/projects/${encodeURIComponent(projectId)}/document`,
      SaveResponse,
      form,
      meta.ifMatch ? { headers: { 'If-Match': meta.ifMatch } } : undefined,
    );
    if (!res.ok) {
      if (res.error.code === 'conflict') throw new CloudConflictError(res.error.message);
      throw apiError(res.error);
    }
    return res.value;
  }

  /**
   * Mint an immutable version from whatever the server currently holds as the
   * live document. Explicit Save, Publish, and session boundaries — not
   * autosave.
   *
   * Sends no document: the server copies its own bytes, so a version cannot
   * disagree with the live document it snapshots.
   */
  async createVersion(
    projectId: string,
    meta: { message?: string; thumbnail?: Blob | null } = {},
  ): Promise<VersionResponse> {
    const form = new FormData();
    if (meta.message) form.append('message', meta.message);
    if (meta.thumbnail) form.append('thumbnail', meta.thumbnail, 'thumb.webp');
    const res = await this.api.request(
      'POST',
      `/api/v1/projects/${encodeURIComponent(projectId)}/revisions`,
      VersionResponse,
      form,
    );
    if (!res.ok) throw apiError(res.error);
    return res.value;
  }

  /**
   * The project's revision history, newest first.
   *
   * "Revision" not "version": a revision is a private snapshot of the working
   * document, while a published *version* is a public release with a
   * changelog. Two different things that briefly shared a URL segment.
   */
  async listRevisions(
    projectId: string,
    opts: { cursor?: string | undefined; limit?: number | undefined } = {},
  ): Promise<RevisionPage> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const query = params.toString();
    const res = await this.api.request(
      'GET',
      `/api/v1/projects/${encodeURIComponent(projectId)}/revisions${query ? `?${query}` : ''}`,
      RevisionPage,
    );
    if (!res.ok) throw apiError(res.error);
    return res.value;
  }

  /** Short-lived signed URL for one revision's bytes, for a read-only preview. */
  async revisionUrl(projectId: string, revisionId: string): Promise<string> {
    const res = await this.api.request(
      'GET',
      `/api/v1/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}`,
      RevisionUrlResponse,
    );
    if (!res.ok) throw apiError(res.error);
    return res.value.downloadUrl;
  }

  /**
   * Make a past revision the live document again.
   *
   * `ifMatch` is the etag the caller believes the live document has; the
   * server refuses if another tab has moved it since. The returned etag must
   * be adopted by the caller — see `cloudAdapter`, where ignoring it would
   * make the next autosave conflict right after the user fixed their work.
   */
  async restoreRevision(
    projectId: string,
    revisionId: string,
    opts: { ifMatch?: string | null } = {},
  ): Promise<RestoreResponse> {
    const headers: Record<string, string> = {};
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    const res = await this.api.request(
      'POST',
      `/api/v1/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/restore`,
      RestoreResponse,
      undefined,
      { headers },
    );
    if (!res.ok) {
      if (res.error.code === 'conflict') throw new CloudConflictError(res.error.message);
      throw apiError(res.error);
    }
    return res.value;
  }

  /**
   * Store one imported file, keyed by its content hash.
   *
   * Re-sending a hash the server already holds is a cheap no-op, which is the
   * common case: every save re-sends the document, and its imports have not
   * changed.
   */
  async putReference(projectId: string, hash: string, body: Uint8Array): Promise<void> {
    const res = await this.api.request(
      'PUT',
      `/api/v1/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(hash)}`,
      PutReferenceResponse,
      new Blob([body as BlobPart], { type: 'application/octet-stream' }),
    );
    if (!res.ok) throw apiError(res.error);
  }

  /** Short-lived signed URL for one stored import. */
  async referenceUrl(projectId: string, hash: string): Promise<string> {
    const res = await this.api.request(
      'GET',
      `/api/v1/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(hash)}`,
      ReferenceUrlResponse,
    );
    if (!res.ok) throw apiError(res.error);
    return res.value.downloadUrl;
  }

  async delete(projectId: string): Promise<void> {
    const res = await this.api.request(
      'DELETE',
      `/api/v1/projects/${encodeURIComponent(projectId)}`,
      DeleteResponse,
    );
    if (!res.ok) throw apiError(res.error);
  }
}

function apiError(e: { code: string; message: string }): Error {
  const err = new Error(`${e.code}: ${e.message}`);
  (err as Error & { code?: string }).code = e.code;
  return err;
}

export { ProjectSummary, Project };
export type { Page, GetResponse, SaveResponse };
