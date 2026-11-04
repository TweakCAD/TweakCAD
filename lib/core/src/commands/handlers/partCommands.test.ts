/**
 * Tests for the SetBodyColor handler.
 */
import { describe, expect, it } from 'vitest';
import { newProjectWithPart } from '../../document/factory.ts';
import type { CadProject } from '../../document/schema.ts';
import type { PartId } from '../../ids.ts';
import type { CadCommand } from '../types.ts';
import { setBodyColorHandler } from './partCommands.ts';

function setup(): { project: CadProject; partId: PartId } {
  const project = newProjectWithPart('Test');
  return { project, partId: Object.keys(project.parts)[0] as PartId };
}

function run(project: CadProject, command: CadCommand): void {
  const v = setBodyColorHandler.validate(command, project);
  if (!v.ok) throw new Error(v.error.message);
  setBodyColorHandler.execute(project, command);
}

describe('setBodyColorHandler', () => {
  it('sets, changes and resets a body colour', () => {
    const { project, partId } = setup();
    run(project, { type: 'SetBodyColor', partId, bodyId: 'body_a', color: '#ff0000' });
    run(project, { type: 'SetBodyColor', partId, bodyId: 'body_b', color: '#00ff00' });
    expect(project.parts[partId]!.bodyColors).toEqual({ body_a: '#ff0000', body_b: '#00ff00' });

    run(project, { type: 'SetBodyColor', partId, bodyId: 'body_a', color: '#0000ff' });
    expect(project.parts[partId]!.bodyColors?.['body_a']).toBe('#0000ff');

    run(project, { type: 'SetBodyColor', partId, bodyId: 'body_a', color: null });
    expect(project.parts[partId]!.bodyColors).toEqual({ body_b: '#00ff00' });
  });

  it('drops the map once the last colour is reset', () => {
    const { project, partId } = setup();
    run(project, { type: 'SetBodyColor', partId, bodyId: 'body_a', color: '#ff0000' });
    run(project, { type: 'SetBodyColor', partId, bodyId: 'body_a', color: null });
    expect('bodyColors' in project.parts[partId]!).toBe(false);
  });

  it('rejects a colour that is not lower-case #rrggbb', () => {
    const { project, partId } = setup();
    for (const color of ['red', '#FF0000', '#f00', '#ff000080']) {
      const v = setBodyColorHandler.validate({ type: 'SetBodyColor', partId, bodyId: 'body_a', color }, project);
      expect(v.ok).toBe(false);
    }
  });

  it('rejects an unknown part', () => {
    const { project } = setup();
    const v = setBodyColorHandler.validate(
      { type: 'SetBodyColor', partId: 'nope' as PartId, bodyId: 'body_a', color: '#ff0000' }, project);
    expect(v.ok).toBe(false);
  });
});
