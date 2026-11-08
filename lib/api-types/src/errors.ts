// GENERATED — DO NOT EDIT HERE.
// The site API's types, as the site defines them. Local edits are overwritten
// when they are copied in again; to propose a change, open an issue or a PR.

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
