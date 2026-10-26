/**
 * A component document, shaped like what the catalog actually serves: an
 * ordinary one-part project whose author marked some parameters public and
 * defined a couple of named sizes.
 *
 * Shared between the panel's form-helper tests and its insertion tests so the
 * two cannot drift into testing different components.
 */

import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import type { CadProject } from '@tweakcad/core/src/document/schema.ts';

/**
 * An M5 hex bolt with two public parameters, one internal helper derived from
 * them, and two configuration rows.
 *
 * The internal `headHeight` matters: it is what proves `publicParameters`
 * filters rather than returning the whole table.
 */
export function hexBoltComponent(): CadProject {
  const project = newProjectWithPart('M5 hex bolt — ISO 4017', 'Bolt');
  const part = Object.values(project.parts)[0]!;
  part.parameters = {
    values: {
      length: {
        name: 'length', expression: '20', unit: 'mm',
        public: true, description: 'Shank length',
      },
      grade: {
        name: 'grade', expression: '8.8', unit: 'mm', public: true,
        kind: 'choice', options: ['8.8', '10.9', '12.9'],
      },
      headHeight: { name: 'headHeight', expression: 'length * 0.2', unit: 'mm' },
    },
  };
  part.configurations = {
    active: 'cfg_m5x20',
    rows: [
      { id: 'cfg_m5x20', name: 'M5×20', overrides: { length: '20' } },
      { id: 'cfg_m5x40', name: 'M5×40', overrides: { length: '40' } },
    ],
  };
  return project;
}
