// GENERATED — DO NOT EDIT HERE.
// Client-safe subset vendored from the private TweakCAD-Site repo. This repo
// has no sync script and cannot regenerate this file. To propose a change,
// open an issue/PR here; a maintainer updates the source in TweakCAD-Site and
// re-syncs. Local edits are overwritten on the next sync.

/**
 * Components catalog — wire types.
 * Phase 3 architectural item. Components are projects with kind='component'
 * plus a component_metadata extension. /components browse + detail.
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
  values: z.array(z.string().max(200)).max(100).optional(),
});
export type ComponentParameter = z.infer<typeof ComponentParameter>;

export const ComponentManifest = z.object({
  schemaVersion: z.literal(1),
  standard: z.string().optional(),
  kernel: z
    .object({ min: z.string().optional(), max: z.string().optional() })
    .optional(),
  // A component with more than 100 parameters is a mistake, not a design.
  parameters: z.array(ComponentParameter).max(100),
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
