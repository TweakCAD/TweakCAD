import { contentHash, isPlainObject, makeSet } from '@tweakcad/format';
import { CommandError } from '../errors';
import { findOwner, findRow, mergeFields, objectAt, type Doc, type Json, type RowAt } from '../rows';
import {
  insertRow,
  mergeNames,
  nameOf,
  removeRow,
  requireRow,
  rowName,
  type Handlers,
  type RunContext,
} from './common';
import type { AssemblyTable } from './types';

const ASSEMBLY_TABLES: Record<AssemblyTable, string> = {
  instances: 'inst',
  jointOrigins: 'jor',
  joints: 'jnt',
  relations: 'rel',
  rigidGroups: 'grp',
  contactSets: 'set',
  positions: 'pos',
  explodedViews: 'exp',
};

function part(doc: Doc, id: string): RowAt {
  return findRow(doc, id, 'part', ['parts']);
}

function assembly(doc: Doc, id: string): RowAt {
  return findRow(doc, id, 'assembly', ['assemblies']);
}

/** Removing a part or assembly also takes it out of the folders; the root cannot be removed. */
function removeTopLevel(ctx: RunContext, at: RowAt, what: string): void {
  const root = ctx.doc.root;
  if (isPlainObject(root)) {
    const tagged = Object.values(root)[0];
    if (isPlainObject(tagged) && tagged.id === at.id) {
      throw new CommandError(
        'not-allowed',
        `the document's root ${what} cannot be removed; make another the root first`,
      );
    }
  }
  const folders = ctx.draft.folders;
  if (Array.isArray(folders)) {
    for (const folder of folders as Json[]) {
      if (Array.isArray(folder.members) && folder.members.includes(at.id)) {
        folder.members = (folder.members as string[]).filter((m) => m !== at.id);
      }
    }
  }
  removeRow(ctx, at);
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A selection set's members, as a canonical set. */
function memberSet(members: unknown): Json {
  const list = Array.isArray(members)
    ? members
    : isPlainObject(members) && Array.isArray(members.set)
      ? members.set
      : undefined;
  if (!list) throw new CommandError('bad-argument', 'members are a list of references');
  try {
    return makeSet(list) as unknown as Json;
  } catch {
    throw new CommandError('bad-argument', 'a selection set holds each reference once');
  }
}

function assemblyRow(doc: Doc, id: string): RowAt {
  const at = findRow(doc, id, 'assembly row', Object.keys(ASSEMBLY_TABLES));
  if (at.path[0] !== 'assemblies') throw new CommandError('not-found', `no assembly row ${id}`);
  return at;
}

export const structureHandlers: Handlers<
  | 'renameDocument'
  | 'addLibraryEntry'
  | 'setRoot'
  | 'setProperty'
  | 'addPart'
  | 'removePart'
  | 'renamePart'
  | 'addAssembly'
  | 'removeAssembly'
  | 'renameAssembly'
  | 'addAttribute'
  | 'editAttribute'
  | 'removeAttribute'
  | 'addSelectionSet'
  | 'editSelectionSet'
  | 'removeSelectionSet'
  | 'addNote'
  | 'editNote'
  | 'removeNote'
  | 'addAssemblyRow'
  | 'editAssemblyRow'
  | 'removeAssemblyRow'
  | 'setActivePosition'
> = {
  renameDocument: {
    label: () => 'Rename document',
    run(c, ctx) {
      objectAt(ctx.draft, ['metadata']).name = c.name;
    },
  },

  addLibraryEntry: {
    label: (c) => `Add ${nameOf(isPlainObject(c.entry) ? c.entry : undefined, 'library entry')}`,
    run(c, ctx) {
      const entry = requireRow(c.entry, 'lib', 'library entry');
      if (c.assets !== undefined && !isPlainObject(c.assets))
        throw new CommandError('bad-argument', 'assets is a map from content hash to asset row');
      const assets = objectAt(ctx.draft, ['assets']);
      for (const [hash, row] of Object.entries(c.assets ?? {})) {
        if (!isPlainObject(row)) throw new CommandError('bad-argument', `asset ${hash} is not an asset row`);
        const data = row.data;
        const base64 = isPlainObject(data) && isPlainObject(data.inline) ? data.inline.base64 : undefined;
        if (typeof base64 === 'string' && contentHash(decodeBase64(base64)) !== hash) {
          throw new CommandError('bad-argument', `asset ${hash} does not hash to its key`);
        }
        if (!(hash in assets)) assets[hash] = row;
      }
      insertRow(ctx, ['library'], entry, c.before, 'library entry');
    },
  },

  setRoot: {
    label: () => 'Set root',
    run(c, ctx) {
      ctx.draft.root = c.root;
    },
  },

  setProperty: {
    label: (c) => (c.property === undefined ? `Remove property ${c.name}` : `Set property ${c.name}`),
    run(c, ctx) {
      const owner = findOwner(ctx.doc, c.owner, ['doc', 'part', 'asm']);
      const properties = objectAt(ctx.draft, [...owner, 'properties']);
      if (c.property === undefined) {
        if (!(c.name in properties)) throw new CommandError('not-found', `no property ${c.name}`);
        Reflect.deleteProperty(properties, c.name);
      } else {
        properties[c.name] = c.property;
      }
    },
  },

  addPart: {
    label: (c) => `Add ${nameOf(c.part, 'part')}`,
    run(c, ctx) {
      insertRow(ctx, ['parts'], requireRow(c.part, 'part', 'part'), c.before, 'part');
    },
  },

  removePart: {
    label: (c, doc) => `Remove ${rowName(doc, c.part, 'part')}`,
    run(c, ctx) {
      removeTopLevel(ctx, part(ctx.doc, c.part), 'part');
    },
  },

  renamePart: {
    label: (c, doc) => `Rename ${rowName(doc, c.part, 'part')}`,
    run(c, ctx) {
      objectAt(ctx.draft, part(ctx.doc, c.part).path).name = c.name;
    },
  },

  addAssembly: {
    label: (c) => `Add ${nameOf(c.assembly, 'assembly')}`,
    run(c, ctx) {
      insertRow(ctx, ['assemblies'], requireRow(c.assembly, 'asm', 'assembly'), c.before, 'assembly');
    },
  },

  removeAssembly: {
    label: (c, doc) => `Remove ${rowName(doc, c.assembly, 'assembly')}`,
    run(c, ctx) {
      removeTopLevel(ctx, assembly(ctx.doc, c.assembly), 'assembly');
    },
  },

  renameAssembly: {
    label: (c, doc) => `Rename ${rowName(doc, c.assembly, 'assembly')}`,
    run(c, ctx) {
      objectAt(ctx.draft, assembly(ctx.doc, c.assembly).path).name = c.name;
    },
  },

  addAttribute: {
    label: () => 'Add attribute',
    run(c, ctx) {
      const owner = findOwner(ctx.doc, c.owner, ['part', 'asm']);
      mergeNames(ctx, c.names);
      insertRow(ctx, [...owner, 'attributes'], requireRow(c.attribute, 'attr', 'attribute'), c.before, 'attribute');
    },
  },

  editAttribute: {
    label: () => 'Edit attribute',
    run(c, ctx) {
      const at = findRow(ctx.doc, c.attribute, 'attribute', ['attributes']);
      const row = objectAt(ctx.draft, at.path);
      mergeNames(ctx, c.names);
      if (c.target !== undefined) row.target = c.target;
      mergeFields(objectAt(row, ['properties']), c.set, c.unset, []);
    },
  },

  removeAttribute: {
    label: () => 'Remove attribute',
    run(c, ctx) {
      removeRow(ctx, findRow(ctx.doc, c.attribute, 'attribute', ['attributes']));
    },
  },

  addSelectionSet: {
    label: (c) => `Add ${nameOf(c.set, 'selection set')}`,
    run(c, ctx) {
      const owner = findOwner(ctx.doc, c.part, ['part']);
      const set = requireRow(c.set, 'set', 'selection set');
      mergeNames(ctx, c.names);
      insertRow(ctx, [...owner, 'sets'], { ...set, members: memberSet(set.members) }, c.before, 'selection set');
    },
  },

  editSelectionSet: {
    label: (c, doc) => `Edit ${rowName(doc, c.set, 'selection set')}`,
    run(c, ctx) {
      const at = findRow(ctx.doc, c.set, 'selection set', ['sets']);
      if (at.path[0] !== 'parts') throw new CommandError('not-found', `no selection set ${c.set}`);
      const row = objectAt(ctx.draft, at.path);
      mergeNames(ctx, c.names);
      if (c.name !== undefined) row.name = c.name;
      if (c.members !== undefined) row.members = memberSet(c.members);
    },
  },

  removeSelectionSet: {
    label: (c, doc) => `Remove ${rowName(doc, c.set, 'selection set')}`,
    run(c, ctx) {
      const at = findRow(ctx.doc, c.set, 'selection set', ['sets']);
      if (at.path[0] !== 'parts') throw new CommandError('not-found', `no selection set ${c.set}`);
      removeRow(ctx, at);
    },
  },

  addNote: {
    label: () => 'Add note',
    run(c, ctx) {
      const owner = findOwner(ctx.doc, c.owner, ['part', 'asm']);
      mergeNames(ctx, c.names);
      insertRow(ctx, [...owner, 'notes'], requireRow(c.note, 'note', 'note'), c.before, 'note');
    },
  },

  editNote: {
    label: () => 'Edit note',
    run(c, ctx) {
      const at = findRow(ctx.doc, c.note, 'note', ['notes']);
      mergeNames(ctx, c.names);
      mergeFields(objectAt(ctx.draft, at.path), c.set, c.unset);
    },
  },

  removeNote: {
    label: () => 'Remove note',
    run(c, ctx) {
      removeRow(ctx, findRow(ctx.doc, c.note, 'note', ['notes']));
    },
  },

  addAssemblyRow: {
    label: (c) => `Add ${nameOf(c.row, c.table === 'instances' ? 'instance' : 'row')}`,
    run(c, ctx) {
      const kind = ASSEMBLY_TABLES[c.table];
      if (!kind) throw new CommandError('bad-argument', `${String(c.table)} is not an assembly table`);
      const owner = assembly(ctx.doc, c.assembly).path;
      mergeNames(ctx, c.names);
      insertRow(ctx, [...owner, c.table], requireRow(c.row, kind, 'row'), c.before, 'row');
    },
  },

  editAssemblyRow: {
    label: (c, doc) => `Edit ${rowName(doc, c.row, 'row')}`,
    run(c, ctx) {
      const at = assemblyRow(ctx.doc, c.row);
      mergeNames(ctx, c.names);
      mergeFields(objectAt(ctx.draft, at.path), c.set, c.unset);
    },
  },

  removeAssemblyRow: {
    label: (c, doc) => `Remove ${rowName(doc, c.row, 'row')}`,
    run(c, ctx) {
      removeRow(ctx, assemblyRow(ctx.doc, c.row));
    },
  },

  setActivePosition: {
    label: () => 'Set active position',
    run(c, ctx) {
      const row = objectAt(ctx.draft, assembly(ctx.doc, c.assembly).path);
      row.activePosition = c.position === undefined ? { current: {} } : { position: { id: c.position } };
    },
  },
};
