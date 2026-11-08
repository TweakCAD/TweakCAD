import type { z } from 'zod';
import { ApiError } from '@tweakcad/api-types';

export type ApiClientConfig = {
  baseUrl: string;
  fetch?: typeof fetch;
};

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.fetchImpl = config.fetch ?? fetch.bind(globalThis);
  }

  async request<TResponse>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    responseSchema: z.ZodType<TResponse>,
    body?: unknown,
    init?: RequestInit,
  ): Promise<ApiResult<TResponse>> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    let bodyInit: BodyInit | null = null;

    if (body instanceof FormData) {
      bodyInit = body;
    } else if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      bodyInit = JSON.stringify(body);
    }

    const requestInit: RequestInit = {
      ...(init ?? {}),
      method,
      headers,
      body: bodyInit,
      credentials: 'include',
    };
    const response = await this.fetchImpl(url, requestInit);

    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    const raw = isJson ? await response.json() : null;

    if (!response.ok) {
      const parsed = ApiError.safeParse(raw);
      if (parsed.success) {
        return { ok: false, error: parsed.data };
      }
      return {
        ok: false,
        error: {
          code: 'internal',
          message: response.statusText || 'Request failed',
          retryable: response.status >= 500,
          requestId: response.headers.get('x-request-id') ?? 'unknown',
        },
      };
    }

    // A host that answers every path with its page (a static server's fallback to
    // index.html) is not the API, however its status reads: only JSON, or an empty
    // 204, comes from the API.
    if (!isJson && response.status !== 204) {
      return {
        ok: false,
        error: {
          code: 'internal',
          message: 'Not an API response',
          retryable: false,
          requestId: response.headers.get('x-request-id') ?? 'unknown',
        },
      };
    }

    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'internal',
          message: 'Response schema mismatch',
          details: parsed.error.issues,
          retryable: false,
          requestId: response.headers.get('x-request-id') ?? 'unknown',
        },
      };
    }
    return { ok: true, value: parsed.data };
  }
}
