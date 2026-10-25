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

/** `POST .../versions` — mints an immutable snapshot of the live document. */
const VersionResponse = z.object({
  versionId: z.string(),
  createdAt: z.string(),
});
type VersionResponse = z.infer<typeof VersionResponse>;

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

  constructor(config: CloudStorageConfig) {
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
      `/api/v1/projects/${encodeURIComponent(projectId)}/versions`,
      VersionResponse,
      form,
    );
    if (!res.ok) throw apiError(res.error);
    return res.value;
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
