/**
 * Boot when the URL names a cloud project and the signed-in load fails.
 *
 * The property guarded here: a project that cannot be read never opens as a
 * blank document bound to that project. That blank showed up as "the model
 * is gone, and the name is a random one", and its first autosave replaced
 * the real document on the server.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';

const loadCloudProject = vi.fn();
const getByCloudProjectId = vi.fn();

vi.mock('./cloudAdapter.ts', () => ({ loadCloudProject }));
vi.mock('./localStore.ts', () => ({
  localStore: {
    getByCloudProjectId,
    get: vi.fn(),
    mostRecent: vi.fn(),
    clearAll: vi.fn(),
  },
  inferStorage: vi.fn(),
}));
vi.mock('./saasState.ts', () => ({
  probeSaas: vi.fn(async () => ({ kind: 'available', signedIn: true })),
  isSignedIn: (s: { kind: string; signedIn?: boolean }) => s.kind === 'available' && !!s.signedIn,
}));
vi.mock('./offlineChoice.ts', () => ({ hasChosenOffline: () => false }));

const { resolveInitialProject, describeCloudLoadError } = await import('./boot.ts');

const realWindow = globalThis.window;
const realLocation = globalThis.location;

function openUrl(href: string) {
  const location = { href, search: new URL(href).search };
  (globalThis as { window?: unknown }).window = { location };
  (globalThis as { location?: unknown }).location = location;
}

beforeEach(() => {
  vi.clearAllMocks();
  getByCloudProjectId.mockResolvedValue(undefined);
  openUrl('https://tweakcad.com/cad?project=proj_1');
});

afterEach(() => {
  if (realWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
  else (globalThis as { window?: unknown }).window = realWindow;
  if (realLocation === undefined) Reflect.deleteProperty(globalThis, 'location');
  else (globalThis as { location?: unknown }).location = realLocation;
});

const blank = () => newProjectWithPart('random-name', 'Part 1');

describe('resolveInitialProject — named cloud project', () => {
  it('opens the cloud document and binds the window to the project', async () => {
    const doc = newProjectWithPart('Enclosure', 'Part 1');
    loadCloudProject.mockResolvedValue({ name: 'Enclosure', doc, etag: 'e1' });

    const res = await resolveInitialProject(blank());

    expect('doc' in res && res.doc).toBe(doc);
    expect('context' in res && res.context).toEqual({
      kind: 'cloud', cloudProjectId: 'proj_1', localId: 'cloud-mirror-proj_1',
    });
  });

  it('shows the failure instead of a blank document when the load fails', async () => {
    loadCloudProject.mockRejectedValue(new Error('internal: Response schema mismatch'));

    const res = await resolveInitialProject(blank());

    expect('doc' in res).toBe(false);
    expect(res).toMatchObject({ kind: 'load-failed', message: 'Response schema mismatch.' });
  });

  it("opens this browser's copy detached, so it cannot overwrite the project", async () => {
    const mirrorDoc = newProjectWithPart('Enclosure', 'Part 1');
    getByCloudProjectId.mockResolvedValue({ id: 'cloud-mirror-proj_1', name: 'Enclosure', doc: mirrorDoc });
    loadCloudProject.mockRejectedValue(new TypeError('Failed to fetch'));

    const res = await resolveInitialProject(blank());

    expect('doc' in res && res.doc).toBe(mirrorDoc);
    if (!('doc' in res)) throw new Error('expected a document');
    expect(res.context).toEqual({ kind: 'local-stored', localId: 'cloud-mirror-proj_1' });
    expect(res.storage).toEqual({ kind: 'unsaved' });
    expect(res.warning).toContain('The server could not be reached.');
  });
});

describe('describeCloudLoadError', () => {
  it('drops the provider error code', () => {
    expect(describeCloudLoadError(new Error('internal: The project document is unavailable.')))
      .toBe('The project document is unavailable.');
  });

  it('names a missing project', () => {
    expect(describeCloudLoadError(new Error('not_found: Project not found.')))
      .toBe('The project was not found in your account.');
  });

  it('names a network failure', () => {
    expect(describeCloudLoadError(new TypeError('Failed to fetch')))
      .toBe('The server could not be reached.');
  });
});
