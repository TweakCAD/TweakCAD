/**
 * The golden `.cadjson` fixtures must load and build.
 *
 * Both of them used to declare `schemaVersion: "0.1"` with a `displayUnits`
 * field and a composite `"type": "rectangle"` sketch entity — a version the
 * loader refuses and an entity kind invariant #11 says does not exist.
 * Nothing read them, so nothing noticed. They are generated now
 * (`generate.ts`), and this is the check that keeps them honest: a fixture
 * that the real loader rejects, or that rebuilds to no geometry, is worse
 * than no fixture, because whoever picks it up starts from a broken file.
 *
 * Runs on the real OCCT kernel — a fixture that only satisfies MockKernel
 * proves nothing about the profiles resolving to real faces.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCadDocument } from '@tweakcad/core/src/document/loader.ts';
import { CURRENT_SCHEMA_VERSION } from '@tweakcad/core/src/document/version.ts';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import { incrementalRebuild } from '@tweakcad/worker/src/rebuilder.ts';
import { attachTestSolver } from '@tweakcad/testing/src/solver.ts';
import type { CadProject, PartId } from '@tweakcad/core/src/document/schema.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture(file: string): CadProject {
  const raw = JSON.parse(readFileSync(join(HERE, file), 'utf8'));
  const result = loadCadDocument(raw);
  if (!result.ok) throw new Error(`${file}: ${JSON.stringify(result.error)}`);
  return result.value.project;
}

describe('golden fixtures', () => {
  beforeAll(attachTestSolver, 30_000);

  it.each([
    ['simple-box.cadjson', 1],
    ['plate-with-hole.cadjson', 1],
  ])('%s loads and rebuilds to %i body', async (file, expectedBodies) => {
    const project = loadFixture(file);
    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    const kernel = new OcctKernel();
    await kernel.init();
    const partId = (Object.keys(project.parts) as PartId[])[0]!;
    const result = await incrementalRebuild(project.parts[partId]!, project, kernel, 0);

    const failed = result.featureResults.filter((r) => r.status !== 'success');
    expect(failed.map((r) => `${r.featureId}: ${r.status}`)).toEqual([]);
    expect(result.bodies).toHaveLength(expectedBodies);
  }, 60_000);
});
