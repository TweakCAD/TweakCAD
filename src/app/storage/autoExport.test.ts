import { describe, expect, it } from 'vitest';
import { runAutoExport, type AutoExportStatus } from './autoExport';

/** Runs the export against a site whose current-version answer is `body`; the statuses it reported, and whether it exported. */
async function run(body: string): Promise<{ statuses: AutoExportStatus[]; exported: boolean }> {
  const statuses: AutoExportStatus[] = [];
  let exported = false;
  await runAutoExport({
    projectId: 'p1',
    exportShown: () => {
      exported = true;
      return Promise.resolve(new Uint8Array());
    },
    onStatus: (s) => statuses.push(s),
    fetch: () => Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
  });
  return { statuses, exported };
}

describe('the version auto-export uploads to', () => {
  it('stops before exporting when the answer holds no version label', async () => {
    for (const body of ['{"versionLabel": 7}', '{}', 'null', 'not json']) {
      const { statuses, exported } = await run(body);
      expect(exported, body).toBe(false);
      expect(statuses.map((s) => s.kind)).toEqual(['failed', 'done']);
    }
  });
});
