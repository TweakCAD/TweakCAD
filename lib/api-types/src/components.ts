// GENERATED — DO NOT EDIT HERE.
// Client-safe subset of the server API contract, vendored into this repo.
// This repo has no sync script and cannot regenerate this file. To propose a
// change, open an issue/PR here; a maintainer updates the upstream source and
// re-syncs. Local edits are overwritten on the next sync.

/**
 * Components catalog — wire types.
 * Components are projects with kind='component' plus a component_metadata
 * extension, browsable and viewable in detail.
 */
import { z } from 'zod';

export const ComponentStatus = z.enum([
  'draft',
  'pending_review',
  'published',
  'archived',
]);
export type ComponentStatus = z.infer<typeof ComponentStatus>;

export const ComponentParameter = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['number', 'enum', 'boolean', 'string']),
  default: z.unknown(),
  range: z.tuple([z.number(), z.number()]).optional(),
  values: z.array(z.string()).optional(),
});
export type ComponentParameter = z.infer<typeof ComponentParameter>;

export const ComponentManifest = z.object({
  schemaVersion: z.literal(1),
  standard: z.string().optional(),
  kernel: z
    .object({ min: z.string().optional(), max: z.string().optional() })
    .optional(),
  parameters: z.array(ComponentParameter),
  installHint: z.string().optional(),
});
export type ComponentManifest = z.infer<typeof ComponentManifest>;

export const ComponentSummary = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  ownerUsername: z.string().nullable(),
  ownerDisplayName: z.string().nullable(),
  ownerAvatarUrl: z.string().nullable(),
  likeCount: z.number().int(),
  viewCount: z.number().int(),
  updatedAt: z.string(),
  standard: z.string().nullable(),
});
export type ComponentSummary = z.infer<typeof ComponentSummary>;

export const ComponentDetail = ComponentSummary.extend({
  status: ComponentStatus,
  manifest: ComponentManifest,
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ComponentDetail = z.infer<typeof ComponentDetail>;

export const ListComponentsResponse = z.object({
  items: z.array(ComponentSummary),
  nextCursor: z.string().nullable(),
});
export type ListComponentsResponse = z.infer<typeof ListComponentsResponse>;
