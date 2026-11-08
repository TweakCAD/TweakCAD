// GENERATED — DO NOT EDIT HERE.
// The site API's types, as the site defines them. Local edits are overwritten
// when they are copied in again; to propose a change, open an issue or a PR.

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
