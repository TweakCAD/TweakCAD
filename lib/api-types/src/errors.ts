// GENERATED — DO NOT EDIT HERE.
// Client-safe subset of the server API contract, vendored into this repo.
// This repo has no sync script and cannot regenerate this file. To propose a
// change, open an issue/PR here; a maintainer updates the upstream source and
// re-syncs. Local edits are overwritten on the next sync.

import { z } from 'zod';

export const ApiErrorCode = z.enum([
  'not_found',
  'unauthenticated',
  'forbidden',
  'conflict',
  'rate_limited',
  'validation',
  'license_no_derivatives',
  'author_disabled',
  'quota_exceeded',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  code: ApiErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
  retryable: z.boolean(),
  requestId: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;
