// GENERATED — DO NOT EDIT HERE.
// Client-safe subset of the server API contract, vendored into this repo.
// This repo has no sync script and cannot regenerate this file. To propose a
// change, open an issue/PR here; a maintainer updates the upstream source and
// re-syncs. Local edits are overwritten on the next sync.

import { z } from 'zod';

export const PageRequest = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type PageRequest = z.infer<typeof PageRequest>;

export const PageResponse = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
export type Page<T> = { items: T[]; nextCursor: string | null };
