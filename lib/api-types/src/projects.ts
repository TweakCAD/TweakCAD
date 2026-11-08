// GENERATED — DO NOT EDIT HERE.
// The site API's types, as the site defines them. Local edits are overwritten
// when they are copied in again; to propose a change, open an issue or a PR.

import { z } from 'zod';

// The project types the editor receives and sends: the project metadata it
// reads and creates.

/**
 * URL field restricted to the http(s) schemes. `z.string().url()` alone still
 * accepts `javascript:` / `data:` URLs (they parse as valid URLs), which become
 * a stored-XSS vector once rendered into an anchor `href` — React does not block
 * those schemes. Use this for any user-supplied URL that may reach the DOM.
 */
export const httpUrl = (opts?: { max?: number }) => {
  let s = z.string().url();
  if (opts?.max != null) s = s.max(opts.max);
  return s.refine((u) => /^https?:\/\//i.test(u), {
    message: 'URL must use http or https',
  });
};

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
  externalSourceUrl: httpUrl({ max: 1000 }).optional(),
  externalSourceLabel: z.string().max(200).optional(),
  originalAuthorName: z.string().max(200).optional(),
});
export type ExternalAttribution = z.infer<typeof ExternalAttribution>;

/**
 * A project's name as the owner sets it, on create and on rename. Trimmed
 * before the length check, so a name of spaces is empty rather than valid.
 * The editor clamps `metadata.name` to the same 200 characters.
 */
export const ProjectName = z.string().trim().min(1).max(200);

export const CreateProjectRequest = z
  .object({
    name: ProjectName,
    /** Default 'model'. Reserved for future kind-specific create flows. */
    kind: ProjectKind.optional(),
    description: z.string().optional(),
    // Capped: an unbounded array of unbounded strings is the shape zod 3
    // can exhaust memory validating, and 20 tags is already generous.
    tags: z.array(z.string().min(1).max(50)).max(20).default([]),
    /** FK to a taxonomy category; validate it exists in the DAL. */
    categoryId: z.string().optional(),
  })
  .merge(ExternalAttribution);
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/** `PATCH /projects/{id}` — rename. The slug is not touched. */
export const RenameProjectRequest = z.object({ name: ProjectName });
export type RenameProjectRequest = z.infer<typeof RenameProjectRequest>;
