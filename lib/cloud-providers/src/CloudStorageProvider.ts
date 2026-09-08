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

const SaveResponse = z.object({
  versionId: z.string(),
  savedAt: z.string(),
  etag: z.string(),
});
type SaveResponse = z.infer<typeof SaveResponse>;

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

  async save(
    projectId: string,
    cadjson: Blob | File,
    meta: { message?: string; thumbnail?: Blob | null } = {},
  ): Promise<SaveResponse> {
    const form = new FormData();
    form.append('cadjson', cadjson, 'document.cadjson');
    if (meta.message) form.append('message', meta.message);
    if (meta.thumbnail) form.append('thumbnail', meta.thumbnail, 'thumb.webp');
    const res = await this.api.request(
      'PUT',
      `/api/v1/projects/${encodeURIComponent(projectId)}/document`,
      SaveResponse,
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
