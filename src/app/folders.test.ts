import { describe, expect, it } from 'vitest';
import { dropCommand, flatFolders, folderTree, foldersOf, moveCommand, moveTargets, type TreeFolder } from './folders';

// Frame holds Bolts (which holds Nuts); Spares stands at the top level.
const FOLDERS: TreeFolder[] = [
  { id: 'fld_frame', name: 'Frame', parent: null, members: ['part_a', 'part_b'] },
  { id: 'fld_bolts', name: 'Bolts', parent: 'fld_frame', members: ['part_c'] },
  { id: 'fld_spares', name: 'Spares', parent: null, members: ['asm_x'] },
  { id: 'fld_nuts', name: 'Nuts', parent: 'fld_bolts', members: [] },
];
const tree = folderTree(FOLDERS);

describe('the folder tree', () => {
  it('reads the document’s folders and nests them in table order', () => {
    const doc = {
      folders: [
        { id: 'fld_1', name: 'One', members: ['part_a'], parent: { top: {} } },
        { id: 'fld_2', name: 'Two', members: [], parent: { folder: { id: 'fld_1' } } },
      ],
    };
    expect(foldersOf(doc)).toEqual([
      { id: 'fld_1', name: 'One', parent: null, members: ['part_a'] },
      { id: 'fld_2', name: 'Two', parent: 'fld_1', members: [] },
    ]);
    expect(tree.top).toEqual(['fld_frame', 'fld_spares']);
    expect(tree.children.get('fld_frame')).toEqual(['fld_bolts']);
    expect(tree.folderOf.get('part_c')).toBe('fld_bolts');
    expect(flatFolders(tree).map((f) => `${f.level}:${f.folder.name}`)).toEqual([
      '0:Frame',
      '1:Bolts',
      '2:Nuts',
      '0:Spares',
    ]);
  });

  it('shows a folder whose parent is gone at the top level', () => {
    const orphan = folderTree([{ id: 'fld_o', name: 'O', parent: 'fld_gone', members: [] }]);
    expect(orphan.top).toEqual(['fld_o']);
  });
});

describe('dropping in the tree', () => {
  it('moves an item into a folder, before another item, or to the top level', () => {
    expect(dropCommand(tree, { item: 'part_z' }, { folder: 'fld_spares', zone: 'into' })).toEqual([
      { type: 'moveToFolder', items: ['part_z'], folder: 'fld_spares' },
    ]);
    // A folder's top edge takes an item into the folder too.
    expect(dropCommand(tree, { item: 'part_z' }, { folder: 'fld_spares', zone: 'before' })).toMatchObject([
      { folder: 'fld_spares' },
    ]);
    expect(dropCommand(tree, { item: 'part_b' }, { item: 'part_a' })).toEqual([
      { type: 'moveToFolder', items: ['part_b'], folder: 'fld_frame', before: 'part_a' },
    ]);
    expect(dropCommand(tree, { item: 'part_a' }, { top: true })).toEqual([{ type: 'moveToFolder', items: ['part_a'] }]);
  });

  it('orders the top level by kind: before another part or assembly, or last on the space below', () => {
    // Two parts at the top level.
    expect(dropCommand(tree, { item: 'part_z' }, { item: 'part_y' })).toEqual([
      { type: 'movePart', part: 'part_z', before: 'part_y' },
    ]);
    // Out of a folder and before a part at the top level, as one step.
    expect(dropCommand(tree, { item: 'part_a' }, { item: 'part_z' })).toEqual([
      { type: 'moveToFolder', items: ['part_a'] },
      { type: 'movePart', part: 'part_a', before: 'part_z' },
    ]);
    expect(dropCommand(tree, { item: 'asm_y' }, { item: 'asm_w' })).toEqual([
      { type: 'moveAssembly', assembly: 'asm_y', before: 'asm_w' },
    ]);
    // A part dropped on an assembly at the top level only leaves its folder.
    expect(dropCommand(tree, { item: 'part_z' }, { item: 'asm_w' })).toBeNull();
    expect(dropCommand(tree, { item: 'part_a' }, { item: 'asm_w' })).toEqual([
      { type: 'moveToFolder', items: ['part_a'] },
    ]);
    expect(dropCommand(tree, { item: 'part_a' }, { end: true })).toEqual([
      { type: 'moveToFolder', items: ['part_a'] },
      { type: 'movePart', part: 'part_a' },
    ]);
    expect(dropCommand(tree, { item: 'part_z' }, { end: true })).toEqual([{ type: 'movePart', part: 'part_z' }]);
    expect(dropCommand(tree, { item: 'lib_z' }, { end: true })).toBeNull();
  });

  it('does nothing where the item already is', () => {
    expect(dropCommand(tree, { item: 'part_a' }, { folder: 'fld_frame', zone: 'into' })).toBeNull();
    expect(dropCommand(tree, { item: 'part_a' }, { item: 'part_a' })).toBeNull();
    expect(dropCommand(tree, { item: 'part_z' }, { top: true })).toBeNull();
  });

  it('nests a folder, orders it before a sibling, and never puts it inside itself', () => {
    expect(dropCommand(tree, { folder: 'fld_spares' }, { folder: 'fld_bolts', zone: 'into' })).toEqual([
      { type: 'moveFolder', folder: 'fld_spares', parent: 'fld_bolts' },
    ]);
    expect(dropCommand(tree, { folder: 'fld_spares' }, { folder: 'fld_frame', zone: 'before' })).toEqual([
      { type: 'moveFolder', folder: 'fld_spares', before: 'fld_frame' },
    ]);
    expect(dropCommand(tree, { folder: 'fld_bolts' }, { top: true })).toEqual([
      { type: 'moveFolder', folder: 'fld_bolts' },
    ]);
    // The space below the rows: last of the top level's folders.
    expect(dropCommand(tree, { folder: 'fld_frame' }, { end: true })).toEqual([
      { type: 'moveFolder', folder: 'fld_frame' },
    ]);
    // Onto an item: into that item's folder.
    expect(dropCommand(tree, { folder: 'fld_spares' }, { item: 'part_c' })).toEqual([
      { type: 'moveFolder', folder: 'fld_spares', parent: 'fld_bolts' },
    ]);
    expect(dropCommand(tree, { folder: 'fld_frame' }, { folder: 'fld_nuts', zone: 'into' })).toBeNull();
    expect(dropCommand(tree, { folder: 'fld_frame' }, { folder: 'fld_frame', zone: 'into' })).toBeNull();
    expect(dropCommand(tree, { folder: 'fld_frame' }, { item: 'part_c' })).toBeNull();
    expect(dropCommand(tree, { folder: 'fld_bolts' }, { folder: 'fld_frame', zone: 'into' })).toBeNull();
  });
});

describe('the move menu', () => {
  it('offers every folder but the one an item is in', () => {
    expect(moveTargets(tree, { item: 'part_c' }).map((t) => t.folder.id)).toEqual([
      'fld_frame',
      'fld_nuts',
      'fld_spares',
    ]);
  });

  it('offers a folder neither itself, its own folders nor its parent', () => {
    expect(moveTargets(tree, { folder: 'fld_bolts' }).map((t) => t.folder.id)).toEqual(['fld_spares']);
    expect(moveCommand({ folder: 'fld_bolts' }, null)).toEqual({ type: 'moveFolder', folder: 'fld_bolts' });
    expect(moveCommand({ item: 'part_a' }, 'fld_spares')).toEqual({
      type: 'moveToFolder',
      items: ['part_a'],
      folder: 'fld_spares',
    });
  });
});
