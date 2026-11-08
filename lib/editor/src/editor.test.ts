import { NameTable, contentHash, nameHash, readDocument, writeDocument } from '@tweakcad/format';
import { afterAll, describe, expect, it } from 'vitest';
import { COMMAND_TYPES, Editor, type CommandResult } from './editor';
import type { CommandType, EditorCommand } from './commands/types';
import { seededIds } from './ids';
import { getAt, idIndex, objectAt, type Json } from './rows';
import { PLACEMENT_TEXT, standardDocument, type StandardIds, type TestDoc } from './testDocs';

const covered = new Set<CommandType>();

function setup(): { editor: Editor; ids: StandardIds; t: TestDoc } {
  const { doc, ids, t } = standardDocument();
  return { editor: new Editor(doc, { ids: seededIds(7) }), ids, t };
}

/** The document's canonical text. */
function bytes(editor: Editor): string {
  return writeDocument(editor.document);
}

/**
 * Runs a command that must succeed and change the document, then checks
 * that the result reads with no refusals and that undo and redo restore
 * each state byte for byte.
 */
function run(editor: Editor, command: EditorCommand): Json {
  covered.add(command.type);
  const before = bytes(editor);
  const result = editor.dispatch(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
  expect(result.changed).toBe(true);
  expect(readDocument(editor.document).refused).toBe(false);
  const after = bytes(editor);
  expect(after).not.toBe(before);
  expect(editor.undo()).toBe(true);
  expect(bytes(editor)).toBe(before);
  expect(editor.redo()).toBe(true);
  expect(bytes(editor)).toBe(after);
  return editor.document;
}

/** Runs a command that must be refused, and checks the store is untouched. */
function refused(editor: Editor, command: EditorCommand): Extract<CommandResult, { ok: false }> {
  covered.add(command.type);
  const before = bytes(editor);
  const revision = editor.store.revision;
  const logged = editor.log.length;
  const result = editor.dispatch(command);
  if (result.ok) throw new Error(`${command.type} was not refused`);
  expect(bytes(editor)).toBe(before);
  expect(editor.store.revision).toBe(revision);
  expect(editor.log.length).toBe(logged);
  return result;
}

function at(editor: Editor, id: string): Json {
  const path = idIndex(editor.document).get(id);
  if (!path) throw new Error(`no ${id}`);
  return objectAt(editor.document, path);
}

function has(editor: Editor, id: string): boolean {
  return idIndex(editor.document).has(id);
}

function timelineIds(editor: Editor, part = 0): string[] {
  return ((objectAt(editor.document, ['parts', part]).timeline as Json[]) ?? []).map((f) => f.id as string);
}

function exprText(value: Json): string {
  return ((value.def as Json).expr as Json).text as string;
}

describe('document, parts and assemblies', () => {
  it('renames the document and sets the root', () => {
    const { editor, ids } = setup();
    run(editor, { type: 'renameDocument', name: 'Bracket set' });
    expect((editor.document.metadata as Json).name).toBe('Bracket set');
    run(editor, { type: 'setRoot', root: { assembly: { id: ids.assembly } } });
    expect(editor.document.root).toEqual({ assembly: { id: ids.assembly } });
    refused(editor, { type: 'setRoot', root: { part: { id: ids.assembly } } });
  });

  it('adds a library entry with the assets it names, keeping an asset already held', () => {
    const { editor } = setup();
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251]);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const hash = contentHash(bytes);
    const asset = {
      mediaType: 'font/ttf',
      name: 'Face.ttf',
      size: bytes.length,
      data: { inline: { base64: btoa(binary) } },
    };
    const content = { inline: { definition: { asset: hash } } };
    const entry = {
      id: editor.newId('lib'),
      hash: nameHash(content),
      kind: 'font',
      content,
      source: { local: {} },
      name: 'Face',
    };
    const doc = run(editor, { type: 'addLibraryEntry', entry, assets: { [hash]: asset } });
    expect((doc.library as Json[]).map((e) => e.id)).toEqual([entry.id]);
    expect((doc.assets as Json)[hash]).toEqual(asset);
    const second = { ...entry, id: editor.newId('lib'), name: 'Face again' };
    run(editor, { type: 'addLibraryEntry', entry: second, assets: { [hash]: { ...asset, name: 'Other.ttf' } } });
    expect(((editor.document.assets as Json)[hash] as Json).name).toBe('Face.ttf');
    refused(editor, {
      type: 'addLibraryEntry',
      entry: { ...entry, id: editor.newId('lib') },
      assets: { [hash.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))]: asset },
    });
  });

  it('adds, renames and removes parts and assemblies', () => {
    const { editor, t } = setup();
    const part = t.part('Spacer');
    run(editor, { type: 'addPart', part });
    expect((editor.document.parts as Json[]).map((p) => p.name)).toEqual(['Bracket', 'Spacer']);
    run(editor, { type: 'renamePart', part: part.id as string, name: 'Washer' });
    expect(at(editor, part.id as string).name).toBe('Washer');
    run(editor, { type: 'removePart', part: part.id as string });
    expect(has(editor, part.id as string)).toBe(false);

    const assembly = t.assembly('Sub');
    run(editor, { type: 'addAssembly', assembly });
    run(editor, { type: 'renameAssembly', assembly: assembly.id as string, name: 'Frame' });
    expect(at(editor, assembly.id as string).name).toBe('Frame');
    run(editor, { type: 'removeAssembly', assembly: assembly.id as string });
    expect(has(editor, assembly.id as string)).toBe(false);
  });

  it('refuses to remove the root part or a part an instance places', () => {
    const { editor, ids } = setup();
    expect(refused(editor, { type: 'removePart', part: ids.part }).error.message).toMatch(/root part/);
    run(editor, { type: 'setRoot', root: { assembly: { id: ids.assembly } } });
    expect(refused(editor, { type: 'removePart', part: ids.part }).error.code).toBe('invalid');
    expect(refused(editor, { type: 'removeAssembly', assembly: ids.assembly }).error.code).toBe('not-allowed');
  });

  it('takes a removed part out of its folder', () => {
    const { doc, t } = standardDocument();
    // The builder's part list is the document's.
    const spare = t.part('Spare');
    doc.folders = [{ id: t.id('fld'), name: 'Spares', members: [spare.id], parent: { top: {} } }];
    const editor = new Editor(doc);
    run(editor, { type: 'removePart', part: spare.id as string });
    expect((editor.document.folders as Json[])[0]?.members).toEqual([]);
  });

  it('sets and removes properties on the document, parts and assemblies', () => {
    const { editor, ids, t } = setup();
    for (const owner of [editor.document.id as string, ids.part, ids.assembly]) {
      run(editor, { type: 'setProperty', owner, name: 'stock', property: { type: 'text', value: t.val('"steel"') } });
      run(editor, { type: 'setProperty', owner, name: 'stock' });
    }
    expect(refused(editor, { type: 'setProperty', owner: ids.part, name: 'absent' }).error.code).toBe('not-found');
  });
});

describe('feature groups', () => {
  it('groups features of a timeline, renames and edits the group, and ungroups', () => {
    const { editor, ids, t } = setup();
    const group = { id: t.id('grp'), name: 'Base', members: [ids.sketch, ids.extrude] };
    run(editor, { type: 'addGroup', part: ids.part, group });
    expect(editor.log.at(-1)?.label).toBe('Group Base');
    run(editor, { type: 'removeGroup', group: group.id });
    run(editor, { type: 'addGroup', part: ids.part, group: { ...group, id: t.id('grp'), name: 'Group 1' } });
    expect(editor.log.at(-1)?.label).toBe('Add Group 1');
    editor.undo();
    editor.undo();
    run(editor, { type: 'editGroup', group: group.id, name: 'Plate' });
    expect(at(editor, group.id).name).toBe('Plate');
    run(editor, { type: 'editGroup', group: group.id, members: [ids.sketch, ids.extrude, ids.extrude2] });
    // A feature is in one group at most, and only of its own timeline.
    expect(
      refused(editor, {
        type: 'addGroup',
        part: ids.part,
        group: { id: t.id('grp'), name: 'Again', members: [ids.extrude2] },
      }).error.code,
    ).toBe('not-allowed');
    expect(refused(editor, { type: 'editGroup', group: group.id, members: [ids.sketch, ids.sketch] }).error.code).toBe(
      'not-allowed',
    );
    expect(
      refused(editor, { type: 'editGroup', group: group.id, members: ['feat_aaaaaaaaaaaaaaaaaaaaaaaaaa'] }).error.code,
    ).toBe('not-found');
    // Removing a member feature takes it out of the group.
    run(editor, { type: 'removeFeature', feature: ids.extrude2 });
    expect(at(editor, group.id).members).toEqual([ids.sketch, ids.extrude]);
    run(editor, { type: 'removeGroup', group: group.id });
    expect(has(editor, group.id)).toBe(false);
    expect(refused(editor, { type: 'removeGroup', group: group.id }).error.code).toBe('not-found');
  });

  it('keeps a group to features next to each other as features are added, moved and removed', () => {
    const { editor, ids, t } = setup();
    const group = { id: t.id('grp'), name: 'Base', members: [ids.extrude, ids.sketch] };
    run(editor, { type: 'addGroup', part: ids.part, group });
    // Members are stored in timeline order; a gap is refused, and so is an empty group.
    expect(at(editor, group.id).members).toEqual([ids.sketch, ids.extrude]);
    expect(
      refused(editor, { type: 'editGroup', group: group.id, members: [ids.sketch, ids.extrude2] }).error.message,
    ).toMatch(/next to each other/);
    expect(
      refused(editor, { type: 'addGroup', part: ids.part, group: { id: t.id('grp'), name: 'None', members: [] } }).error
        .code,
    ).toBe('bad-argument');
    // A feature added between two members joins their group; one added at its edge does not.
    const plane = t.feature('core.constructionPlane', { frame: t.fixedFrame() }, 'Plane');
    run(editor, { type: 'addFeature', container: ids.part, feature: plane, before: ids.extrude });
    expect(at(editor, group.id).members).toEqual([ids.sketch, plane.id, ids.extrude]);
    const plane2 = t.feature('core.constructionPlane', { frame: t.fixedFrame() }, 'Plane 2');
    run(editor, { type: 'addFeature', container: ids.part, feature: plane2, before: ids.sketch });
    expect(at(editor, group.id).members).toEqual([ids.sketch, plane.id, ids.extrude]);
    // Moved between members it joins; a member moved away leaves; a member moved to the group's edge stays.
    run(editor, { type: 'moveFeature', feature: plane2.id as string, container: ids.part, before: ids.extrude });
    expect(at(editor, group.id).members).toEqual([ids.sketch, plane.id, plane2.id, ids.extrude]);
    run(editor, { type: 'moveFeature', feature: plane.id as string, container: ids.part });
    expect(at(editor, group.id).members).toEqual([ids.sketch, plane2.id, ids.extrude]);
    run(editor, { type: 'moveFeature', feature: plane2.id as string, container: ids.part, before: ids.sketch });
    expect(at(editor, group.id).members).toEqual([plane2.id, ids.sketch, ids.extrude]);
    // A group whose last member is removed goes with it.
    const alone = { id: t.id('grp'), name: 'Alone', members: [plane.id as string] };
    run(editor, { type: 'addGroup', part: ids.part, group: alone });
    run(editor, { type: 'removeFeature', feature: plane.id as string });
    expect(has(editor, alone.id)).toBe(false);
  });
});

describe('features', () => {
  it('adds a feature at the end or before another', () => {
    const { editor, ids, t } = setup();
    const plane = t.feature('core.constructionPlane', { frame: t.fixedFrame() }, 'Plane');
    run(editor, { type: 'addFeature', container: ids.part, feature: plane, before: ids.extrude });
    expect(timelineIds(editor)).toEqual([ids.sketch, plane.id, ids.extrude, ids.extrude2]);
    expect(editor.log.at(-1)?.label).toBe('Add Plane');
    const last = t.feature('core.constructionPlane', { frame: t.fixedFrame() }, 'Plane 2');
    run(editor, { type: 'addFeature', container: ids.part, feature: last });
    expect(timelineIds(editor).at(-1)).toBe(last.id);
  });

  it('adds a feature whose references bring name-table entries', () => {
    const { editor, ids, t } = setup();
    const region = { ...((at(editor, ids.sketch).inputs as Json).regions as Json[])[0], id: t.id('reg') } as Json;
    run(editor, { type: 'pickRegion', sketch: ids.sketch, region });
    const names = new NameTable();
    const profile = t.regionRef(ids.sketch, region.id as string, names);
    const extrude = t.extrude(ids.sketch, [profile], t.val('3 mm'));
    const missing = () => readDocument(editor.document).diagnostics.filter((d) => d.code === 'missing-name');
    // Without its entries the record names hashes the table lacks, and the feature pauses.
    expect(editor.dispatch({ type: 'addFeature', container: ids.part, feature: extrude }).ok).toBe(true);
    expect(missing().length).toBeGreaterThan(0);
    editor.undo();
    run(editor, { type: 'addFeature', container: ids.part, feature: extrude, names: names.toJson() });
    for (const hash of (profile.entity as Json).id as string[]) expect(editor.document.names).toHaveProperty(hash);
    expect(missing()).toEqual([]);
  });

  it('adds a feature with the asset rows it uses, and undo takes them out again', () => {
    const { editor, ids, t } = setup();
    const row = (text: string, mediaType: string) => {
      const data = new TextEncoder().encode(text);
      return [
        contentHash(data),
        { mediaType, name: 'part.step', size: data.length, data: { inline: { base64: btoa(text) } } },
      ] as const;
    };
    const [file, fileRow] = row('ISO-10303-21;', 'model/step');
    const [shape, shapeRow] = row('CASCADE Topology V3', 'model/x-brep');
    const imported = t.feature('core.import', {
      source: { file: { asset: file } },
      stored: { asset: shape, representation: { name: 'brep', version: 1 }, map: [] },
      importer: { format: 'step', version: '1' },
      units: t.val('"mm"'),
      upAxis: t.val('"y"'),
    });
    // Without its rows the feature names assets the document lacks.
    expect(refused(editor, { type: 'addFeature', container: ids.part, feature: imported }).error.code).toBe('invalid');
    run(editor, {
      type: 'addFeature',
      container: ids.part,
      feature: imported,
      assets: { [file]: fileRow, [shape]: shapeRow },
    });
    expect(Object.keys(editor.document.assets as Json)).toEqual(expect.arrayContaining([file, shape]));
    editor.undo();
    expect(editor.document.assets).not.toHaveProperty(file);
    expect(
      refused(editor, { type: 'addFeature', container: ids.part, feature: imported, assets: { notahash: fileRow } })
        .error.code,
    ).toBe('bad-argument');
  });

  it('refuses a feature whose inputs break the format', () => {
    const { editor, ids, t } = setup();
    const broken = t.feature('core.constructionPlane', { frame: { fixed: {} } });
    const result = refused(editor, { type: 'addFeature', container: ids.part, feature: broken });
    expect(result.error.code).toBe('invalid');
    expect(result.error.diagnostics?.length).toBeGreaterThan(0);
    // A value id that already exists is a duplicate definition.
    const duplicate = t.feature('core.constructionPlane', { frame: { fixed: { placement: at(editor, ids.depth) } } });
    expect(refused(editor, { type: 'addFeature', container: ids.part, feature: duplicate }).error.code).toBe('invalid');
  });

  it('adds, moves and removes features in a composite', () => {
    const { editor, ids, t } = setup();
    const composite: Json = { ...t.feature('core.composite', { parameters: [] }, 'Group'), children: [] };
    run(editor, { type: 'addFeature', container: ids.part, feature: composite });
    const child = t.feature('core.constructionPlane', { frame: t.fixedFrame() }, 'Inner');
    run(editor, { type: 'addFeature', container: composite.id as string, feature: child });
    expect((at(editor, composite.id as string).children as Json[]).map((f) => f.id)).toEqual([child.id]);
    run(editor, { type: 'moveFeature', feature: child.id as string, container: ids.part, before: ids.sketch });
    expect(timelineIds(editor)[0]).toBe(child.id);
    run(editor, { type: 'moveFeature', feature: child.id as string, container: composite.id as string });
    expect(timelineIds(editor)).not.toContain(child.id);
    run(editor, { type: 'removeFeature', feature: composite.id as string });
    expect(has(editor, child.id as string)).toBe(false);
    expect(refused(editor, { type: 'addFeature', container: ids.extrude, feature: child }).error.code).toBe(
      'not-allowed',
    );
  });

  it('moves a feature within its timeline, refusing a move before a value it uses', () => {
    const { editor, ids, t } = setup();
    // extrude2 uses `depth`, a named value of extrude: it cannot move before it.
    expect(
      refused(editor, { type: 'moveFeature', feature: ids.extrude2, container: ids.part, before: ids.extrude }).error
        .message,
    ).toMatch(/later feature/);
    const plane = t.feature('core.constructionPlane', { frame: t.fixedFrame() }, 'Plane');
    run(editor, { type: 'addFeature', container: ids.part, feature: plane });
    run(editor, { type: 'moveFeature', feature: plane.id as string, container: ids.part, before: ids.sketch });
    expect(timelineIds(editor)).toEqual([plane.id, ids.sketch, ids.extrude, ids.extrude2]);
  });

  it('refuses a move into another part', () => {
    const { editor, ids, t } = setup();
    const other = t.part('Other');
    run(editor, { type: 'addPart', part: other });
    expect(
      refused(editor, { type: 'moveFeature', feature: ids.extrude2, container: other.id as string }).error.code,
    ).toBe('not-allowed');
  });

  it('removes a feature with its groups, rollback and configuration overrides', () => {
    const { doc, ids, t } = standardDocument();
    const part = (doc.parts as Json[])[0] as Json;
    part.groups = [{ id: t.id('grp'), name: 'Body', members: [ids.extrude, ids.extrude2] }];
    part.rollback = { before: { id: ids.extrude2 } };
    const config = (part.configurations as Json[])[0] as Json;
    (config.rows as Json[]).push({
      option: { equals: { literal: 'medium' } },
      overrides: [{ input: { feature: { id: ids.extrude2 }, pointer: '/thin', with: { solid: {} } } }],
    });
    const size = (((doc.parameters as Json[])[0] as Json).parameters as Json[])[1] as Json;
    size.options = ['small', 'large', 'medium'];
    const editor = new Editor(doc);
    run(editor, { type: 'removeFeature', feature: ids.extrude2 });
    const after = objectAt(editor.document, ['parts', 0]);
    expect((after.groups as Json[])[0]?.members).toEqual([ids.extrude]);
    expect(after.rollback).toEqual({ end: {} });
    expect(((after.configurations as Json[])[0]?.rows as Json[])[2]?.overrides).toEqual([]);
  });

  it('refuses to remove a feature whose named value a later feature uses', () => {
    const { editor, ids } = setup();
    const result = refused(editor, { type: 'removeFeature', feature: ids.extrude });
    expect(result.error.code).toBe('invalid');
    expect(result.error.message).toMatch(new RegExp(ids.depth));
  });

  it('renames, suppresses and unsuppresses a feature', () => {
    const { editor, ids } = setup();
    run(editor, { type: 'renameFeature', feature: ids.extrude, name: 'Base' });
    expect(at(editor, ids.extrude).name).toBe('Base');
    run(editor, { type: 'setSuppressed', feature: ids.extrude, suppressed: true });
    expect(editor.log.at(-1)?.label).toBe('Suppress Base');
    expect(exprText(at(editor, ids.extrude).suppressed as Json)).toBe('true');
    // Suppressing again changes nothing and records no undo step.
    const again = editor.dispatch({ type: 'setSuppressed', feature: ids.extrude, suppressed: true });
    expect(again).toEqual({ ok: true, label: 'Suppress Base', changed: false });
    run(editor, { type: 'setSuppressed', feature: ids.extrude, suppressed: false });
    expect(editor.store.undoLabel()).toBe('Unsuppress Base');
  });

  it('freezes a feature with the assets its stored shapes use, and makes it live again', () => {
    const { editor, ids } = setup();
    const data = new TextEncoder().encode('CASCADE Topology V3');
    const hash = contentHash(data);
    const asset = {
      mediaType: 'model/x-brep',
      name: 'frozen.brep',
      size: data.length,
      data: { inline: { base64: btoa('CASCADE Topology V3') } },
    };
    const frozen = { frozen: { effects: [], construction: [], values: {} } };
    run(editor, { type: 'setFrozen', feature: ids.extrude, frozen, assets: { [hash]: asset } });
    expect(at(editor, ids.extrude).frozen).toEqual(frozen);
    expect((editor.document.assets as Json)[hash]).toEqual(asset);
    expect(editor.store.undoLabel()).toBe('Freeze Extrude');
    run(editor, { type: 'setFrozen', feature: ids.extrude });
    expect(at(editor, ids.extrude).frozen).toEqual({ live: {} });
    expect(editor.store.undoLabel()).toBe('Unfreeze Extrude');
    // Live already: nothing changes.
    expect(editor.dispatch({ type: 'setFrozen', feature: ids.extrude })).toEqual({
      ok: true,
      label: 'Unfreeze Extrude',
      changed: false,
    });
    expect(refused(editor, { type: 'setFrozen', feature: ids.sketch, frozen }).error.code).toBe('not-allowed');
    expect(refused(editor, { type: 'setFrozen', feature: ids.extrude, frozen: { effects: [] } }).error.code).toBe(
      'bad-argument',
    );
  });

  it('sets the rollback', () => {
    const { editor, ids } = setup();
    run(editor, { type: 'setRollback', part: ids.part, before: ids.extrude });
    expect(objectAt(editor.document, ['parts', 0]).rollback).toEqual({ before: { id: ids.extrude } });
    run(editor, { type: 'setRollback', part: ids.part });
    refused(editor, { type: 'setRollback', part: ids.part, before: ids.position });
  });
});

describe('replacing input subtrees', () => {
  it('replaces a structural part by pointer, stepping into tables by row id', () => {
    const { editor, ids, t } = setup();
    run(editor, {
      type: 'replaceInput',
      feature: ids.extrude2,
      pointer: '/sides/0/extent',
      with: { throughAll: {} },
    });
    expect(getAt(at(editor, ids.extrude2), ['inputs', 'sides', 0, 'extent'])).toEqual({ throughAll: {} });
    // A table step is the row id: move one sketch point.
    run(editor, { type: 'replaceInput', feature: ids.sketch, pointer: `/points/${ids.points[2]}/x`, with: 45 });
    expect(at(editor, ids.points[2] as string).x).toBe(45);
    // A step into a table by position is refused.
    expect(
      refused(editor, { type: 'replaceInput', feature: ids.sketch, pointer: '/points/0/x', with: 1 }).error.code,
    ).toBe('not-found');
    // Appending to an ordered list, and removing a key.
    run(editor, {
      type: 'replaceInput',
      feature: ids.extrude2,
      pointer: '/sides/-',
      with: { extent: { distance: { d: t.val('5 mm') } }, taper: t.val('0 deg') },
    });
    expect((getAt(at(editor, ids.extrude2), ['inputs', 'sides']) as Json[]).length).toBe(2);
    run(editor, { type: 'replaceInput', feature: ids.extrude2, pointer: '/sides/1' });
    expect((getAt(at(editor, ids.extrude2), ['inputs', 'sides']) as Json[]).length).toBe(1);
  });

  it('makes no undo step for inputs written back unchanged', () => {
    const { editor, ids } = setup();
    const before = editor.store.undoLabel();
    const inputs = structuredClone(at(editor, ids.extrude2).inputs as Json);
    const result = editor.transaction('Edit Extrude', () =>
      editor.dispatch({ type: 'replaceInput', feature: ids.extrude2, pointer: '', with: inputs }),
    );
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(editor.store.undoLabel()).toBe(before);
  });

  it('replaces all of the inputs at once, merging the names their references bring', () => {
    const { editor, ids, t } = setup();
    const inputs = structuredClone(at(editor, ids.extrude2).inputs as Json);
    const region = { ...((at(editor, ids.sketch).inputs as Json).regions as Json[])[0], id: t.id('reg') } as Json;
    run(editor, { type: 'pickRegion', sketch: ids.sketch, region });
    const names = new NameTable();
    inputs.profiles = { set: [t.regionRef(ids.sketch, region.id as string, names)] };
    run(editor, { type: 'replaceInput', feature: ids.extrude2, pointer: '', with: inputs, names: names.toJson() });
    expect(getAt(at(editor, ids.extrude2), ['inputs', 'profiles'])).toEqual(inputs.profiles);
    expect(readDocument(editor.document).diagnostics.filter((d) => d.code === 'missing-name')).toEqual([]);
  });

  it('refuses a replacement the feature type does not accept', () => {
    const { editor, ids } = setup();
    expect(
      refused(editor, { type: 'replaceInput', feature: ids.extrude2, pointer: '/thin', with: 'thin' }).error.code,
    ).toBe('invalid');
    expect(
      refused(editor, { type: 'replaceInput', feature: ids.extrude2, pointer: '/nowhere/deep', with: {} }).error.code,
    ).toBe('not-found');
    expect(
      refused(editor, { type: 'replaceInput', feature: ids.extrude2, pointer: 'sides', with: {} }).error.code,
    ).toBe('bad-argument');
  });
});

describe('writeReference', () => {
  it('adds a picked record to a profile set and merges its names', () => {
    const { editor, ids, t } = setup();
    // A second region in the sketch, and a reference to it as the worker would hand over.
    const sketch = at(editor, ids.sketch);
    const region = { ...((sketch.inputs as Json).regions as Json[])[0], id: t.id('reg') } as Json;
    run(editor, { type: 'pickRegion', sketch: ids.sketch, region });
    const names = new NameTable();
    const reference = t.regionRef(ids.sketch, region.id as string, names);
    run(editor, {
      type: 'writeReference',
      feature: ids.extrude2,
      pointer: '/profiles',
      reference,
      names: names.toJson(),
    });
    const profiles = getAt(at(editor, ids.extrude2), ['inputs', 'profiles', 'set']) as Json[];
    expect(profiles).toHaveLength(2);
    expect(profiles).toContainEqual(reference);
    for (const hash of (reference.entity as Json).id as string[]) expect(editor.document.names).toHaveProperty(hash);
    expect(readDocument(editor.document).diagnostics.filter((d) => d.code === 'missing-name')).toEqual([]);
    // The same record again is refused: a set holds it once.
    expect(
      refused(editor, { type: 'writeReference', feature: ids.extrude2, pointer: '/profiles', reference, names: {} })
        .error.code,
    ).toBe('not-allowed');
  });

  it('replaces a single reference and refuses name entries that do not hash to their keys', () => {
    const { editor, ids } = setup();
    const reference = { standard: { name: 'xy' } };
    run(editor, {
      type: 'writeReference',
      feature: ids.extrude2,
      pointer: '/direction/normal/ref',
      reference,
      names: {},
    });
    expect(getAt(at(editor, ids.extrude2), ['inputs', 'direction', 'normal', 'ref'])).toEqual(reference);
    const bad = { aaaaaaaaaaaaaaaaaaaaaaaaaa: { kind: 'face' } };
    expect(
      refused(editor, {
        type: 'writeReference',
        feature: ids.extrude2,
        pointer: '/direction/normal/ref',
        reference,
        names: bad,
      }).error.code,
    ).toBe('bad-argument');
    expect(
      refused(editor, {
        type: 'writeReference',
        feature: ids.extrude2,
        pointer: '/direction/normal/ref',
        reference: { a: {}, b: {} },
        names: {},
      }).error.code,
    ).toBe('bad-argument');
  });
});

describe('values', () => {
  it("sets a value's definition by id", () => {
    const { editor, ids } = setup();
    run(editor, {
      type: 'setValueDef',
      value: ids.depth,
      def: { expr: { text: 'height + 5 mm', grammar: 1, refs: { height: { parameter: { id: ids.height } } } } },
    });
    expect(exprText(at(editor, ids.depth))).toBe('height + 5 mm');
    const sketch = at(editor, ids.sketch);
    const dimension = ((sketch.inputs as Json).constraints as Json[])[0] as Json;
    run(editor, {
      type: 'setValueDef',
      value: (dimension.value as Json).id as string,
      def: { expr: { text: '50 mm', grammar: 1, refs: {} } },
    });
    // A name missing from refs is an integrity error; a wrong type pauses only.
    expect(
      refused(editor, {
        type: 'setValueDef',
        value: ids.depth,
        def: { expr: { text: 'nothing', grammar: 1, refs: {} } },
      }).error.code,
    ).toBe('invalid');
    expect(
      refused(editor, { type: 'setValueDef', value: ids.part, def: { expr: { text: '1', grammar: 1, refs: {} } } })
        .error.code,
    ).toBe('not-found');
  });

  it('renames a named value and rewrites the expressions that use it', () => {
    const { editor, ids } = setup();
    run(editor, { type: 'renameValue', value: ids.depth, name: 'baseDepth' });
    expect(at(editor, ids.depth).name).toBe('baseDepth');
    const second = getAt(at(editor, ids.extrude2), ['inputs', 'sides', 0, 'extent', 'distance', 'd']) as Json;
    expect((second.def as Json).expr).toEqual({
      text: 'baseDepth * 2',
      grammar: 1,
      refs: { baseDepth: { value: { id: ids.depth } } },
    });
    // A name another value or parameter holds is refused.
    expect(refused(editor, { type: 'renameValue', value: ids.depth, name: 'height' }).error.code).toBe('invalid');
    // A value in use cannot lose its name; an unused one can.
    expect(refused(editor, { type: 'renameValue', value: ids.depth }).error.code).toBe('not-allowed');
    run(editor, {
      type: 'setValueDef',
      value: second.id as string,
      def: { expr: { text: '8 mm', grammar: 1, refs: {} } },
    });
    run(editor, { type: 'renameValue', value: ids.depth });
    expect(at(editor, ids.depth).name).toBeUndefined();
  });

  it('sets and clears the public and published flags', () => {
    const { editor, ids } = setup();
    run(editor, { type: 'setValueFlags', value: ids.depth, public: true, published: true });
    expect(at(editor, ids.depth)).toMatchObject({ public: true, published: true });
    run(editor, { type: 'setValueFlags', value: ids.depth, public: false });
    expect(at(editor, ids.depth).public).toBeUndefined();
  });
});

describe('parameters', () => {
  it('adds, renames and removes parameter tables', () => {
    const { editor, ids, t } = setup();
    const table = t.table('Extra', []);
    for (const owner of [editor.document.id as string, ids.part, ids.assembly]) {
      const row = { ...table, id: t.id('tbl') };
      run(editor, { type: 'addParameterTable', owner, table: row });
      run(editor, { type: 'renameParameterTable', table: row.id, name: 'More' });
      expect(at(editor, row.id).name).toBe('More');
      run(editor, { type: 'removeParameterTable', table: row.id });
    }
    expect(refused(editor, { type: 'removeParameterTable', table: ids.docTable }).error.message).toMatch(
      /width is used/,
    );
  });

  it('adds, edits and removes parameters; renaming rewrites refs', () => {
    const { editor, ids, t } = setup();
    const thickness = t.parameter('thickness', '3 mm');
    run(editor, { type: 'addParameter', table: ids.docTable, parameter: thickness, before: ids.size });
    expect((at(editor, ids.docTable).parameters as Json[]).map((p) => p.name)).toEqual(['width', 'thickness', 'size']);
    run(editor, { type: 'editParameter', parameter: ids.width, set: { name: 'span', description: 'Overall span' } });
    expect(at(editor, ids.width)).toMatchObject({ name: 'span', description: 'Overall span' });
    expect(((at(editor, ids.height).value as Json).def as Json).expr).toEqual({
      text: 'span / 2',
      grammar: 1,
      refs: { span: { parameter: { id: ids.width } } },
    });
    const dimension = (((at(editor, ids.sketch).inputs as Json).constraints as Json[])[0] as Json).value as Json;
    expect(exprText(dimension)).toBe('span');
    run(editor, { type: 'removeParameter', parameter: thickness.id as string });
    expect(refused(editor, { type: 'removeParameter', parameter: ids.width }).error.message).toMatch(
      /span is used by 2 expressions/,
    );
    expect(refused(editor, { type: 'editParameter', parameter: ids.width, set: { name: 'size' } }).error.code).toBe(
      'invalid',
    );
    expect(refused(editor, { type: 'editParameter', parameter: ids.width, set: { id: 'par_x' } }).error.code).toBe(
      'bad-argument',
    );
    expect(refused(editor, { type: 'editParameter', parameter: ids.width, unset: ['quantity'] }).error.code).toBe(
      'invalid',
    );
  });

  it('refuses a cycle among table parameters', () => {
    const { editor, ids } = setup();
    const width = at(editor, ids.width);
    const result = refused(editor, {
      type: 'setValueDef',
      value: (width.value as Json).id as string,
      def: { expr: { text: 'height', grammar: 1, refs: { height: { parameter: { id: ids.height } } } } },
    });
    expect(result.error.code).toBe('invalid');
  });
});

describe('configurations', () => {
  it('adds, edits and removes configurations and their rows', () => {
    const { editor, ids, t } = setup();
    const flag = t.parameter('holes', 'true', { type: 'boolean' });
    run(editor, { type: 'addParameter', table: ids.partTable, parameter: flag });
    const configuration = { id: t.id('cfg'), input: { id: flag.id }, rows: [] };
    run(editor, { type: 'addConfiguration', owner: ids.part, configuration });
    const suppress = {
      value: { target: { value: { id: (at(editor, ids.extrude2).suppressed as Json).id } }, def: t.val('true').def },
    };
    run(editor, {
      type: 'addConfigurationRow',
      configuration: configuration.id,
      row: { option: { equals: { literal: false } }, overrides: [suppress] },
    });
    run(editor, {
      type: 'addConfigurationRow',
      configuration: configuration.id,
      row: { option: { equals: { literal: true } }, overrides: [] },
      before: false,
    });
    expect(
      (at(editor, configuration.id).rows as Json[]).map((r) => ((r.option as Json).equals as Json).literal),
    ).toEqual([true, false]);
    run(editor, {
      type: 'editConfigurationRow',
      configuration: configuration.id,
      option: true,
      set: { overrides: [suppress] },
    });
    refused(editor, {
      type: 'addConfigurationRow',
      configuration: configuration.id,
      row: { option: { equals: { literal: true } }, overrides: [] },
    });
    run(editor, { type: 'removeConfigurationRow', configuration: configuration.id, option: false });
    expect(
      refused(editor, { type: 'removeConfigurationRow', configuration: configuration.id, option: false }).error.code,
    ).toBe('not-found');

    // The input moves to another parameter; an input of the wrong type is refused.
    const flag2 = t.parameter('ribs', 'false', { type: 'boolean' });
    run(editor, { type: 'addParameter', table: ids.partTable, parameter: flag2 });
    run(editor, { type: 'setConfigurationInput', configuration: configuration.id, input: flag2.id as string });
    expect(
      refused(editor, { type: 'setConfigurationInput', configuration: configuration.id, input: ids.width }).error.code,
    ).toBe('invalid');
    run(editor, { type: 'removeConfiguration', configuration: configuration.id });
    expect(has(editor, configuration.id)).toBe(false);
  });

  it('refuses a configuration override of the input parameter', () => {
    const { editor, ids, t } = setup();
    const row = {
      option: { equals: { literal: 'large' } },
      overrides: [{ value: { target: { parameter: { id: ids.size } }, def: t.val('"small"').def } }],
    };
    expect(
      refused(editor, { type: 'editConfigurationRow', configuration: ids.configuration, option: 'large', set: row })
        .error.code,
    ).toBe('invalid');
  });
});

describe('attributes, selection sets and notes', () => {
  it('adds, edits and removes attributes', () => {
    const { editor, ids, t } = setup();
    const attribute = {
      id: t.id('attr'),
      target: { object: { feature: { id: ids.extrude } } },
      properties: { visible: t.flag(false) },
    };
    run(editor, { type: 'addAttribute', owner: ids.part, attribute });
    run(editor, { type: 'editAttribute', attribute: attribute.id, set: { opacity: t.val('0.5') }, unset: ['visible'] });
    expect(Object.keys(at(editor, attribute.id).properties as Json)).toEqual(['opacity']);
    run(editor, {
      type: 'editAttribute',
      attribute: attribute.id,
      target: { object: { feature: { id: ids.extrude2 } } },
    });
    // Two attributes setting one property on one target are refused.
    expect(
      refused(editor, {
        type: 'editAttribute',
        attribute: attribute.id,
        target: { object: { part: { id: ids.part } } },
        set: { color: t.val('"#00ff00"') },
      }).error.code,
    ).toBe('invalid');
    run(editor, { type: 'removeAttribute', attribute: attribute.id });
    const onInstance = {
      id: t.id('attr'),
      target: { object: { instance: { path: [{ instance: { id: ids.instances[1] } }] } } },
      properties: { color: t.val('"#0000ff"') },
    };
    run(editor, { type: 'addAttribute', owner: ids.assembly, attribute: onInstance });
  });

  it('adds, edits and removes selection sets', () => {
    const { editor, ids, t } = setup();
    const names = new NameTable();
    const a = t.regionRef(ids.sketch, ids.region, names);
    const b = { standard: { name: 'xy' } };
    const set = { id: t.id('set'), name: 'Faces', members: [b, a] };
    run(editor, { type: 'addSelectionSet', part: ids.part, set, names: names.toJson() });
    expect((at(editor, set.id).members as Json).set).toHaveLength(2);
    run(editor, { type: 'editSelectionSet', set: set.id, name: 'Picked', members: [a] });
    expect(at(editor, set.id)).toMatchObject({ name: 'Picked', members: { set: [a] } });
    expect(refused(editor, { type: 'editSelectionSet', set: set.id, members: [a, a] }).error.code).toBe('bad-argument');
    run(editor, { type: 'removeSelectionSet', set: set.id });
    // A set a reference uses cannot go.
    run(editor, {
      type: 'writeReference',
      feature: ids.extrude2,
      pointer: '/direction/normal/ref',
      reference: { selection: { id: ids.selection } },
      names: {},
    });
    expect(refused(editor, { type: 'removeSelectionSet', set: ids.selection }).error.code).toBe('invalid');
  });

  it('adds, edits and removes notes', () => {
    const { editor, ids, t } = setup();
    const note = {
      id: t.id('note'),
      anchor: { ref: { ref: { object: { feature: { id: ids.extrude } } } } },
      text: 'Deburr',
      kind: 'manufacturing',
    };
    run(editor, { type: 'addNote', owner: ids.part, note });
    run(editor, { type: 'editNote', note: note.id, set: { text: 'Deburr all edges' } });
    expect(at(editor, note.id).text).toBe('Deburr all edges');
    run(editor, { type: 'removeNote', note: note.id });
    run(editor, { type: 'addNote', owner: ids.assembly, note: { ...note, id: t.id('note') } });
    expect(refused(editor, { type: 'editNote', note: ids.note, unset: ['text'] }).error.code).toBe('invalid');
  });
});

describe('assembly rows', () => {
  it('adds, edits and removes instances, joint origins, joints and positions', () => {
    const { editor, ids, t } = setup();
    const instance = t.instance(ids.part);
    run(editor, { type: 'addAssemblyRow', assembly: ids.assembly, table: 'instances', row: instance });
    run(editor, {
      type: 'editAssemblyRow',
      row: instance.id as string,
      set: { placement: { position: [10, 0, 0], rotation: [0, 0, 0, 1] } },
    });
    expect(at(editor, instance.id as string).placement).toEqual({ position: [10, 0, 0], rotation: [0, 0, 0, 1] });
    // A rotation that is not unit length is refused.
    expect(
      refused(editor, {
        type: 'editAssemblyRow',
        row: instance.id as string,
        set: { placement: { position: [0, 0, 0], rotation: [0, 0, 1, 1] } },
      }).error.code,
    ).toBe('invalid');

    const origin = { id: t.id('jor'), frame: t.fixedFrame() };
    run(editor, { type: 'addAssemblyRow', assembly: ids.assembly, table: 'jointOrigins', row: origin });
    const joint = {
      id: t.id('jnt'),
      kind: 'slider',
      a: { origin: { id: ids.origins[0] } },
      b: { origin: { id: origin.id } },
      limits: {},
      rest: {},
      state: {},
      suppressed: t.flag(false),
    };
    run(editor, { type: 'addAssemblyRow', assembly: ids.assembly, table: 'joints', row: joint });
    run(editor, { type: 'editAssemblyRow', row: joint.id, set: { state: { tz: 12.5 } } });
    expect(refused(editor, { type: 'editAssemblyRow', row: joint.id, set: { state: { rz: 1 } } }).error.code).toBe(
      'invalid',
    );
    // The joint origin a joint uses cannot go before the joint.
    expect(refused(editor, { type: 'removeAssemblyRow', row: origin.id }).error.code).toBe('invalid');
    run(editor, { type: 'removeAssemblyRow', row: joint.id });
    run(editor, { type: 'removeAssemblyRow', row: origin.id });

    const position = { id: t.id('pos'), name: 'Closed', state: { [ids.joint]: { rz: 0 } } };
    run(editor, { type: 'addAssemblyRow', assembly: ids.assembly, table: 'positions', row: position });
    run(editor, { type: 'setActivePosition', assembly: ids.assembly, position: position.id });
    expect(at(editor, ids.assembly).activePosition).toEqual({ position: { id: position.id } });
    run(editor, { type: 'setActivePosition', assembly: ids.assembly });
    run(editor, { type: 'removeAssemblyRow', row: instance.id as string });
    expect(
      refused(editor, { type: 'addAssemblyRow', assembly: ids.assembly, table: 'joints', row: instance }).error.code,
    ).toBe('bad-argument');
    expect(refused(editor, { type: 'removeAssemblyRow', row: ids.extrude }).error.code).toBe('not-found');
  });
});

describe('the bus', () => {
  it('refuses an unknown command and leaves the store alone', () => {
    const { editor } = setup();
    const result = editor.dispatch({ type: 'explode' } as unknown as EditorCommand);
    expect(result).toEqual({ ok: false, error: { code: 'unknown-command', message: 'unknown command explode' } });
  });

  it('logs each command with its label, and undo and redo', () => {
    const { editor, ids } = setup();
    editor.dispatch({ type: 'renameFeature', feature: ids.extrude, name: 'Base' });
    editor.dispatch({ type: 'setSuppressed', feature: ids.extrude, suppressed: true });
    editor.undo();
    editor.redo();
    expect(editor.log.map((e) => [e.kind, e.label])).toEqual([
      ['command', 'Rename Extrude'],
      ['command', 'Suppress Base'],
      ['undo', 'Suppress Base'],
      ['redo', 'Suppress Base'],
    ]);
    expect(editor.log[0]?.command).toEqual({ type: 'renameFeature', feature: ids.extrude, name: 'Base' });
  });

  it('groups commands of a transaction into one undo step, nested', () => {
    const { editor, ids } = setup();
    const before = bytes(editor);
    editor.transaction('Resize', () => {
      editor.dispatch({ type: 'renameFeature', feature: ids.extrude, name: 'Base' });
      editor.transaction('Inner', () => {
        editor.dispatch({ type: 'setSuppressed', feature: ids.extrude2, suppressed: true });
        expect(editor.store.canUndo()).toBe(false);
        expect(editor.undo()).toBe(false);
      });
    });
    expect(editor.store.undoLabel()).toBe('Resize');
    const after = bytes(editor);
    editor.undo();
    expect(bytes(editor)).toBe(before);
    expect(editor.store.canUndo()).toBe(false);
    editor.redo();
    expect(bytes(editor)).toBe(after);
  });

  it('reverts a transaction that throws, and drops its log entries', () => {
    const { editor, ids } = setup();
    const before = bytes(editor);
    expect(() =>
      editor.transaction('Fails', () => {
        editor.dispatch({ type: 'renameFeature', feature: ids.extrude, name: 'Base' });
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(bytes(editor)).toBe(before);
    expect(editor.log).toEqual([]);
    expect(editor.store.canUndo()).toBe(false);
  });

  it('requests a rebuild on every document change', () => {
    const { editor, ids } = setup();
    const requests: number[] = [];
    editor.store.onRebuild((_doc, revision) => requests.push(revision));
    editor.dispatch({ type: 'renameFeature', feature: ids.extrude, name: 'Base' });
    editor.dispatch({ type: 'setValueDef', value: ids.depth, def: { expr: { text: '12 mm', grammar: 1, refs: {} } } });
    editor.dispatch({ type: 'renameFeature', feature: ids.extrude, name: 'Base' });
    editor.dispatch({ type: 'removeFeature', feature: ids.position });
    editor.undo();
    expect(requests).toEqual([1, 2, 3]);
  });

  it('makes new ids from its generator, deterministic when seeded', () => {
    const a = new Editor(standardDocument().doc, { ids: seededIds(3) });
    const b = new Editor(standardDocument().doc, { ids: seededIds(3) });
    const id = a.newId('feat');
    expect(id).toMatch(/^feat_[a-z2-7]{26}$/);
    expect(b.newId('feat')).toBe(id);
    expect(a.newId('feat')).not.toBe(id);
  });

  it('runs a command to the end when a listener throws: logged, undoable, every listener told', () => {
    const errors: unknown[] = [];
    const editor = new Editor(standardDocument().doc, { ids: seededIds(7), onListenerError: (e) => errors.push(e) });
    const heard: string[] = [];
    editor.store.subscribe(() => {
      throw new Error('listener failed');
    });
    editor.store.subscribe((c) => heard.push(`change ${c.label}`));
    editor.store.onRebuild((_, revision) => heard.push(`rebuild ${revision}`));
    const result = editor.dispatch({ type: 'renameDocument', name: 'Renamed' });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect((editor.document.metadata as Json).name).toBe('Renamed');
    expect(editor.log).toHaveLength(1);
    expect(editor.store.canUndo()).toBe(true);
    expect(heard).toEqual(['change Rename document', 'rebuild 1']);
    expect(errors.map((e) => (e as Error).message)).toEqual(['listener failed']);
  });

  it('keeps a placement text the editor writes valid', () => {
    const { editor, ids, t } = setup();
    const plane = t.feature('core.constructionPlane', { frame: { fixed: { placement: t.val(PLACEMENT_TEXT) } } });
    run(editor, { type: 'addFeature', container: ids.part, feature: plane });
  });
});

afterAll(() => {
  // Every command type has a test above, in sketch.test.ts or in commands/library.test.ts.
  const sketchOnly = new Set<CommandType>([
    'editSketch',
    'removeLibraryEntry',
    'addContext',
    'editContext',
    'removeContext',
  ]);
  const missing = COMMAND_TYPES.filter((type) => !covered.has(type) && !sketchOnly.has(type));
  expect(missing).toEqual([]);
});
