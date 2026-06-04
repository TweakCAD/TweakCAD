/**
 * Factory functions for creating default document structures.
 */

import type { CadProject, CadPart, ParameterTable, DefaultPlaneSet } from './schema.ts';
import type { PartId } from '../ids.ts';
import { partId, generateId } from '../ids.ts';

const APP_VERSION = '0.1.0';

/**
 * Create a default set of planes for a new part.
 * @returns XY, XZ, YZ default plane references
 */
export function createDefaultPlanes(): DefaultPlaneSet {
  return {
    XY: { type: 'defaultPlane', name: 'XY' },
    XZ: { type: 'defaultPlane', name: 'XZ' },
    YZ: { type: 'defaultPlane', name: 'YZ' },
  };
}

/**
 * Create an empty parameter table.
 * @returns Empty ParameterTable
 */
export function emptyParameterTable(): ParameterTable {
  return { values: {} };
}

/**
 * Create a new empty part.
 * @param name - Part name
 * @returns A new CadPart with default planes and empty timeline
 */
export function createPart(name: string): CadPart {
  return {
    id: partId(generateId('part')),
    name,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    parameters: emptyParameterTable(),
    timeline: [],
    defaultPlanes: createDefaultPlanes(),
  };
}

/**
 * Create a new empty project.
 * @param name - Project name
 * @returns A new CadProject with no parts
 */
export function emptyProject(name = 'Untitled Project'): CadProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: '0.1',
    units: 'mm',
    metadata: {
      name,
      description: '',
      createdAt: now,
      updatedAt: now,
      appVersion: APP_VERSION,
    },
    parameters: emptyParameterTable(),
    parts: {} as Record<PartId, CadPart>,
    references: {},
    assemblies: {},
  };
}

/**
 * Create a project with a single default part.
 * @param projectName - Project name
 * @param partName - Name for the initial part
 * @returns A new CadProject with one part
 */
export function newProjectWithPart(
  projectName = 'Untitled Project',
  partName = 'Part 1',
): CadProject {
  const project = emptyProject(projectName);
  const part = createPart(partName);
  project.parts[part.id] = part;
  return project;
}
