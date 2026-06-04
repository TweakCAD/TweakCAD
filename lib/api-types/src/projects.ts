// GENERATED — DO NOT EDIT HERE.
// Client-safe subset of the server API contract, vendored into this repo.
// This repo has no sync script and cannot regenerate this file. To propose a
// change, open an issue/PR here; a maintainer updates the upstream source and
// re-syncs. Local edits are overwritten on the next sync.

import { z } from 'zod';

// Client-safe project surface. Keep this limited to the DTOs the CAD app
// legitimately receives at runtime (project metadata it reads/creates).
// Server-only types — taxonomy, publish/visibility, the model-card feed,
// remix, and comments + moderation — live elsewhere and must NOT be added
// here.

export const Visibility = z.enum(['private', 'org', 'unlisted', 'public']);
export type Visibility = z.infer<typeof Visibility>;

export const LicenseType = z.enum([
  'cc0',
  'cc-by',
  'cc-by-sa',
  'cc-by-nc',
  'cc-by-nc-sa',
  'cc-by-nd',
  'cc-by-nc-nd',
  'gpl-v3',
  'lgpl-v3',
  'mit',
  'bsd-3',
  'proprietary',
]);
export type LicenseType = z.infer<typeof LicenseType>;

export const License = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cc0') }),
  z.object({ type: z.literal('cc-by') }),
  z.object({ type: z.literal('cc-by-sa') }),
  z.object({ type: z.literal('cc-by-nc') }),
  z.object({ type: z.literal('cc-by-nc-sa') }),
  z.object({ type: z.literal('cc-by-nd') }),
  z.object({ type: z.literal('cc-by-nc-nd') }),
  z.object({ type: z.literal('gpl-v3') }),
  z.object({ type: z.literal('lgpl-v3') }),
  z.object({ type: z.literal('mit') }),
  z.object({ type: z.literal('bsd-3') }),
  z.object({ type: z.literal('proprietary'), terms: z.string() }),
]);
export type License = z.infer<typeof License>;

export const ProjectKind = z.enum(['model', 'component', 'campaign', 'lesson']);
export type ProjectKind = z.infer<typeof ProjectKind>;

export const ProjectSummary = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  kind: ProjectKind,
  description: z.string().nullable(),
  tags: z.array(z.string()),
  /** Resolved FK to the curated taxonomy (null = uncategorized). */
  categoryId: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  visibility: Visibility,
  ownerUsername: z.string().nullable(),
  likeCount: z.number().int(),
  remixCount: z.number().int(),
  viewCount: z.number().int(),
  makeCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const Project = ProjectSummary.extend({
  sourceLicense: License.nullable(),
  outputLicense: License.nullable(),
  allowRemix: z.boolean(),
  externalSourceUrl: z.string().nullable(),
  externalSourceLabel: z.string().nullable(),
  remixedFrom: z.string().nullable(),
  remixedFromVersionId: z.string().nullable(),
  originalProjectId: z.string().nullable(),
  originalAuthorId: z.string().nullable(),
  originalAuthorName: z.string().nullable(),
  documentBlobUrl: z.string().nullable(),
  sizeBytes: z.number().int(),
  storageId: z.string(),
});
export type Project = z.infer<typeof Project>;

/**
 * Attribution to a model hosted on another platform (Printables,
 * Thingiverse, GitHub, etc.) the user is remixing or was inspired by.
 *
 * All three fields are independent — the user can supply any subset:
 *   - URL alone → "External source: <url>"
 *   - URL + label → "External source: <label>"  (label is the display text)
 *   - + author → "Originally by <author>" line in the lineage section
 *
 * Used both at project create-time (you start a new model inspired by an
 * external one) and at publish-time (you can backfill / update before
 * making it public).
 */
export const ExternalAttribution = z.object({
  externalSourceUrl: z.string().url().max(1000).optional(),
  externalSourceLabel: z.string().max(200).optional(),
  originalAuthorName: z.string().max(200).optional(),
});
export type ExternalAttribution = z.infer<typeof ExternalAttribution>;

export const CreateProjectRequest = z
  .object({
    name: z.string().min(1).max(200),
    /** Default 'model'. Reserved for future kind-specific create flows. */
    kind: ProjectKind.optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    /** FK to a taxonomy category; validate it exists in the DAL. */
    categoryId: z.string().optional(),
  })
  .merge(ExternalAttribution);
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
