/**
 * Command handlers for Part operations.
 */

import type { Result } from '../../result.ts';
import { ok, err } from '../../result.ts';
import type { CadProject } from '../../document/schema.ts';
import { BODY_COLOR_PATTERN } from '../../document/schema.ts';
import { generateId, partId } from '../../ids.ts';
import type { PartId } from '../../ids.ts';
import type { CadCommand } from '../types.ts';
import type { CommandHandler, ValidationError } from '../bus.ts';

export const createPartHandler: CommandHandler = {
  validate(command: CadCommand, _state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreatePart') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreatePart command' });
    }
    if (!command.name.trim()) {
      return err({ code: 'INVALID_NAME', message: 'Part name cannot be empty', field: 'name' });
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreatePart') return;
    const id = partId(generateId('part'));
    const now = new Date().toISOString();
    draft.parts[id] = {
      id,
      name: command.name,
      parameters: { values: {} },
      timeline: [],
      defaultPlanes: {
        XY: { type: 'defaultPlane', name: 'XY' },
        XZ: { type: 'defaultPlane', name: 'XZ' },
        YZ: { type: 'defaultPlane', name: 'YZ' },
      },
    };
    draft.metadata.updatedAt = now;
  },
};

export const renamePartHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'RenamePart') {
      return err({ code: 'WRONG_TYPE', message: 'Expected RenamePart command' });
    }
    if (!command.name.trim()) {
      return err({ code: 'INVALID_NAME', message: 'Part name cannot be empty', field: 'name' });
    }
    if (!state.parts[command.partId as PartId]) {
      return err({ code: 'NOT_FOUND', message: `Part not found: ${command.partId}` });
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'RenamePart') return;
    const part = draft.parts[command.partId as PartId];
    if (part) {
      part.name = command.name;
      draft.metadata.updatedAt = new Date().toISOString();
    }
  },
};

export const setBodyColorHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SetBodyColor') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SetBodyColor command' });
    }
    if (!state.parts[command.partId as PartId]) {
      return err({ code: 'NOT_FOUND', message: `Part not found: ${command.partId}` });
    }
    if (!command.bodyId) {
      return err({ code: 'INVALID_BODY', message: 'Body id cannot be empty', field: 'bodyId' });
    }
    if (command.color !== null && !BODY_COLOR_PATTERN.test(command.color)) {
      return err({ code: 'INVALID_COLOR', message: `Color must be #rrggbb in lower case: ${command.color}`, field: 'color' });
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SetBodyColor') return;
    const part = draft.parts[command.partId as PartId];
    if (!part) return;
    if (command.color === null) {
      if (!part.bodyColors || !(command.bodyId in part.bodyColors)) return;
      const rest = Object.fromEntries(
        Object.entries(part.bodyColors).filter(([id]) => id !== command.bodyId),
      );
      if (Object.keys(rest).length === 0) delete part.bodyColors;
      else part.bodyColors = rest;
    } else {
      part.bodyColors ??= {};
      part.bodyColors[command.bodyId] = command.color;
    }
    draft.metadata.updatedAt = new Date().toISOString();
  },
};

/**
 * Project-level rename — drives `project.metadata.name`. Validation
 * matches the part rename: empty / whitespace-only names rejected.
 * Names are clamped to 200 chars to keep stray paste-bombs out of the
 * doc; the UI truncates at ~240px well before that.
 */
const MAX_PROJECT_NAME_CHARS = 200;

export const renameProjectHandler: CommandHandler = {
  validate(command: CadCommand, _state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'RenameProject') {
      return err({ code: 'WRONG_TYPE', message: 'Expected RenameProject command' });
    }
    if (!command.name.trim()) {
      return err({ code: 'INVALID_NAME', message: 'Project name cannot be empty', field: 'name' });
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'RenameProject') return;
    const trimmed = command.name.trim().slice(0, MAX_PROJECT_NAME_CHARS);
    draft.metadata.name = trimmed;
    draft.metadata.updatedAt = new Date().toISOString();
  },
};
