/**
 * Component catalog DAL helpers.
 *
 * Thin wrappers around the generic ApiClient that point at the public
 * /api/v1/components endpoints, parse responses with the api-types Zod
 * schemas, and surface the same { ok, value | error } contract as the
 * rest of the client.
 */

import { z } from 'zod';
import {
  ComponentDetail,
  ListComponentsResponse,
  type ComponentDetail as ComponentDetailT,
  type ListComponentsResponse as ListComponentsResponseT,
} from '@tweakcad/api-types';
import type { ApiClient, ApiResult } from './client.ts';

export type ListComponentsOptions = {
  /** ISO timestamp from a previous response's nextCursor. */
  cursor?: string | undefined;
  /** Page size, server clamps to [1, 100]. Default 24. */
  limit?: number | undefined;
  /** Category ID — server expands to the subtree via category.path. */
  categoryId?: string | undefined;
  /** Full-text fragment matched against name + description. */
  search?: string | undefined;
};

function buildListPath(opts: ListComponentsOptions): string {
  const params = new URLSearchParams();
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.categoryId) params.set('category', opts.categoryId);
  if (opts.search) params.set('q', opts.search);
  const query = params.toString();
  return query ? `/api/v1/components?${query}` : '/api/v1/components';
}

export function listComponents(
  client: ApiClient,
  opts: ListComponentsOptions = {},
): Promise<ApiResult<ListComponentsResponseT>> {
  return client.request('GET', buildListPath(opts), ListComponentsResponse);
}

export function getComponentBySlug(
  client: ApiClient,
  slug: string,
): Promise<ApiResult<ComponentDetailT>> {
  return client.request(
    'GET',
    `/api/v1/components/${encodeURIComponent(slug)}`,
    ComponentDetail,
  );
}

/**
 * Fetch a published component's `.cadcomponent` document.
 *
 * Returned as `unknown` on purpose. The real validator is `loadCadDocument`
 * in core, which knows every feature type and can degrade a single bad
 * feature instead of rejecting the file — a Zod schema here would be a
 * second, weaker definition of the same thing, and the two would drift.
 */
export function getComponentDocument(
  client: ApiClient,
  slug: string,
): Promise<ApiResult<unknown>> {
  return client.request(
    'GET',
    `/api/v1/components/${encodeURIComponent(slug)}/document`,
    z.unknown(),
  );
}
