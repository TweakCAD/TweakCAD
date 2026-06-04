/**
 * Shared ApiClient instance for the CAD editor.
 *
 * Targets the same-origin /api/v1 endpoints. In dev, Vite proxies these to
 * the SaaS site on :3000 (see vite.config.ts). In prod, the bundle is
 * served from /cad on the same origin as the API so an empty base URL is
 * the right choice — fetch resolves it against window.location.
 */

import { ApiClient } from '@tweakcad/api-client';

let client: ApiClient | null = null;

export function getApiClient(): ApiClient {
  if (!client) {
    client = new ApiClient({ baseUrl: '' });
  }
  return client;
}
