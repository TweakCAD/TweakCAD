/** A new, empty version-2 document: one part, which is the root. */
import type { Doc, IdGenerator } from '@tweakcad/editor';
import packageJson from '../../package.json';

/** What this build writes as `metadata.writer`. */
export const WRITER = { app: 'TweakCAD', version: packageJson.version } as const;

/** A time as the format stores it: RFC 3339 UTC, to the second. */
export function formatTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface NewDocumentOptions {
  ids: IdGenerator;
  name: string;
  partName?: string;
  now?: Date;
}

/** An empty part row with every table the format requires. */
export function emptyPart(id: string, name: string): Doc {
  return {
    id,
    name,
    parameters: [],
    timeline: [],
    rollback: { end: {} },
    groups: [],
    sets: [],
    contexts: [],
    attributes: [],
    configurations: [],
    notes: [],
    properties: {},
  };
}

export function newDocument({ ids, name, partName = 'Part 1', now = new Date() }: NewDocumentOptions): Doc {
  const part = ids('part');
  const time = formatTime(now);
  return {
    format: 'tweakcad.document',
    schemaVersion: 2,
    namingRules: 1,
    id: ids('doc'),
    metadata: {
      name,
      description: '',
      createdAt: time,
      updatedAt: time,
      writer: { ...WRITER },
      origin: { original: {} },
    },
    properties: {},
    settings: {},
    parameters: [],
    parts: [emptyPart(part, partName)],
    assemblies: [],
    root: { part: { id: part } },
    folders: [],
    views: [],
    library: [],
    assets: {},
    names: {},
  };
}
