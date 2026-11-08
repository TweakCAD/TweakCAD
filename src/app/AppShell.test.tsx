/**
 * The shell's static markup while a revision is previewed: the banner, and
 * every editing control left out or disabled while the viewing ones stay.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { seededIds } from '@tweakcad/editor';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import type { RibbonToolGroup } from '../components/MainToolbar.tsx';
import { AppShell, type AppShellProps } from './AppShell';
import { bootApp, type AppServiceClient, type AppServices } from './services';
import { resolveBoot } from './storage/boot';
import { CloudProjects } from './storage/cloud';
import { FakeSite } from './storage/fakeSite';
import { MemoryWorkingCopy } from './storage/workingCopy';

const display = (generation: number): Display => ({
  generation,
  definitions: [],
  parts: {},
  assemblies: [],
  entities: [],
  pauses: [],
  stale: [],
  outOfDate: [],
  timing: { evaluate: 0, display: 0, resumed: 0 },
});

/** The worker service as far as booting and showing a document goes. */
function client(): AppServiceClient {
  let generation = 0;
  return {
    init: () => Promise.resolve({ loadTimeMs: 1 }),
    evaluate: () => Promise.resolve(display(++generation)),
  } as unknown as AppServiceClient;
}

const tool = (id: string) => ({ id, label: id, icon: null, onClick: () => undefined });
const TOOLS: RibbonToolGroup[] = [
  { label: 'CREATE', tools: [tool('sketch'), tool('extrude')] },
  { label: 'INSPECT', tools: [tool('section'), tool('measure')] },
];

async function cloudApp(): Promise<{ services: AppServices; revision: string }> {
  const site = new FakeSite();
  const cloud = new CloudProjects(site, site);
  const { id } = await cloud.create('Plate');
  const workingCopy = new MemoryWorkingCopy();
  const ids = seededIds(13);
  const outcome = await resolveBoot({
    workingCopy,
    localId: null,
    projectId: id,
    reset: false,
    ids,
    name: () => 'unused',
    saas: { reachable: true, signedIn: true },
    offlineChosen: false,
    cloud,
  });
  if (outcome.kind !== 'document') throw new Error(outcome.kind);
  const { services } = await bootApp({
    client: client(),
    workingCopy,
    localId: null,
    boot: outcome.boot,
    cloud,
    ids,
    autosaveMs: 5,
  });
  services.editor.dispatch({ type: 'renameDocument', name: 'Kept' });
  await services.session.save();
  services.editor.dispatch({ type: 'renameDocument', name: 'Live' });
  return { services, revision: site.projects.get(id)!.revisions[0]!.versionId };
}

function shell(services: AppServices): string {
  const none = () => undefined;
  const props: AppShellProps = {
    services,
    tools: TOOLS,
    onNew: none,
    onOpen: none,
    onSave: none,
    onSaveAs: none,
    onExport: none,
    onImport: none,
    onImportComponent: none,
    saas: { kind: 'unavailable', reason: 'test' },
    onRequestSignIn: none,
    onSignOut: none,
    onOpenSettings: none,
    onOpenHistory: none,
    onRestoreRevision: () => Promise.resolve(),
  };
  return renderToStaticMarkup(<AppShell {...props} />);
}

/** The buttons titled `title`, whether each is disabled. */
const buttons = (html: string, title: string) =>
  [...html.matchAll(/<button[^>]*>/g)]
    .filter((m) => m[0].includes(`title="${title}"`))
    .map((m) => / disabled=""/.test(m[0]));

describe('the shell during a revision preview', () => {
  it('shows the banner and leaves out or disables every editing control', async () => {
    const { services, revision } = await cloudApp();
    const live = shell(services);
    expect(live).not.toContain('read-only');
    expect(buttons(live, 'Undo: Rename document')).toEqual([false]);
    expect(live).toContain('title="Rename &quot;Live&quot;"');
    expect(live).toContain('title="New part"');
    expect(buttons(live, 'sketch')).toEqual([false]);
    expect(live).toContain('Import');

    await services.session.previewRevision(revision, 'Kept (Fri 6 Nov 10:00)');
    const html = shell(services);
    expect(html).toContain('Preview of <b>Kept (Fri 6 Nov 10:00)</b> — read-only');
    expect(html).toMatch(/<button[^>]*>Restore<\/button>/);
    expect(html).toMatch(/<button[^>]*>Close<\/button>/);
    // Undo and redo, the project's rename, imports and New Part.
    expect(buttons(html, 'Nothing to undo')).toEqual([true]);
    expect(buttons(html, 'Nothing to redo')).toEqual([true]);
    expect(html).not.toContain('Rename &quot;');
    expect(html).not.toContain('title="New part"');
    expect(html).not.toContain('Import');
    // The ribbon: the viewing tools only.
    expect(buttons(html, 'sketch')).toEqual([true]);
    expect(buttons(html, 'extrude')).toEqual([true]);
    expect(buttons(html, 'section')).toEqual([false]);
    expect(buttons(html, 'measure')).toEqual([false]);
    // The timeline's rollback.
    expect(buttons(html, 'To start')).toEqual([true]);
    // Export stays.
    expect(html).toContain('Export');

    services.session.closePreview();
    const back = shell(services);
    expect(back).not.toContain('read-only');
    expect(buttons(back, 'Undo: Rename document')).toEqual([false]);
    services.dispose();
  });
});
