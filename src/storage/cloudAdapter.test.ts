/**
 * Tests for the cloud save path — the autosave/versioning split and the
 * `If-Match` precondition.
 *
 * `src/storage/` had no tests at all, which is how a 2-second autosave
 * debounce came to mint a permanent R2 object, a database row and a canvas
 * readback per keystroke burst without anyone noticing.
 *
 * Two properties here are the ones that cost real money or real work:
 *
 *   1. **Autosave does not create versions.** If `saveCloudProject` ever
 *      starts minting snapshots again, storage growth goes unbounded.
 *   2. **Every save after the first states what it replaces.** Without the
 *      etag the server cannot distinguish a normal save from one made
 *      against a document another tab already moved, and the loser's work
 *      disappears with no error shown.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// The provider is the seam: stub it so these tests cover OUR adapter logic —
// etag bookkeeping and which endpoint gets called — not HTTP.
const save = vi.fn();
const createVersion = vi.fn();
const load = vi.fn();

class StubConflictError extends Error {}

vi.mock('@tweakcad/cloud-providers', () => ({
  CloudStorageProvider: class {
    save = save;
    createVersion = createVersion;
    load = load;
  },
  CloudConflictError: StubConflictError,
}));

vi.mock('./thumbnailCapture.ts', () => ({
  captureThumbnail: vi.fn(async () => null),
}));

const { saveCloudProject, createCloudVersion, clearCloudEtag } = await import('./cloudAdapter.ts');

const PROJECT = 'proj_1';
const doc = () => ({ schemaVersion: 1, metadata: { name: 'x' } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  clearCloudEtag(PROJECT);
  save.mockResolvedValue({ etag: 'etag-1', savedAt: '2026-01-01T00:00:00.000Z' });
  createVersion.mockResolvedValue({ versionId: 'rev_1', createdAt: '2026-01-01T00:00:00.000Z' });
});

describe('saveCloudProject — autosave', () => {
  it('does NOT create a version', async () => {
    await saveCloudProject(PROJECT, doc());
    expect(save).toHaveBeenCalledTimes(1);
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('sends no thumbnail — that is a canvas readback, not an autosave concern', async () => {
    await saveCloudProject(PROJECT, doc());
    const [, , meta] = save.mock.calls[0]!;
    expect(meta).not.toHaveProperty('thumbnail');
  });

  it('sends no If-Match on the very first save, having nothing to compare', async () => {
    await saveCloudProject(PROJECT, doc());
    expect(save.mock.calls[0]![2]).toEqual({ ifMatch: null });
  });

  it('sends the previous etag on every subsequent save', async () => {
    await saveCloudProject(PROJECT, doc());
    save.mockResolvedValue({ etag: 'etag-2', savedAt: 'later' });
    await saveCloudProject(PROJECT, doc());
    await saveCloudProject(PROJECT, doc());

    expect(save.mock.calls[1]![2]).toEqual({ ifMatch: 'etag-1' });
    // Advances as the server moves, rather than pinning the first one.
    expect(save.mock.calls[2]![2]).toEqual({ ifMatch: 'etag-2' });
  });

  it('tracks etags per project, not globally', async () => {
    await saveCloudProject(PROJECT, doc());
    save.mockResolvedValue({ etag: 'other-1', savedAt: 'x' });
    await saveCloudProject('proj_2', doc());
    // proj_2 has its own history and must not inherit proj_1's precondition.
    expect(save.mock.calls[1]![2]).toEqual({ ifMatch: null });
    clearCloudEtag('proj_2');
  });

  it('propagates a conflict instead of swallowing it', async () => {
    save.mockRejectedValueOnce(new StubConflictError('moved'));
    await expect(saveCloudProject(PROJECT, doc())).rejects.toBeInstanceOf(StubConflictError);
  });

  it('does not advance the etag when the save failed', async () => {
    await saveCloudProject(PROJECT, doc());
    save.mockRejectedValueOnce(new Error('network'));
    await expect(saveCloudProject(PROJECT, doc())).rejects.toThrow('network');

    save.mockResolvedValue({ etag: 'etag-2', savedAt: 'x' });
    await saveCloudProject(PROJECT, doc());
    // Still replacing etag-1: the failed write never became the server state.
    expect(save.mock.calls[2]![2]).toEqual({ ifMatch: 'etag-1' });
  });

  it('clearCloudEtag makes the next save unconditional', async () => {
    await saveCloudProject(PROJECT, doc());
    clearCloudEtag(PROJECT);
    await saveCloudProject(PROJECT, doc());
    expect(save.mock.calls[1]![2]).toEqual({ ifMatch: null });
  });
});

describe('createCloudVersion — deliberate save points', () => {
  it('sends no document body; the server copies its own bytes', async () => {
    await createCloudVersion(PROJECT);
    expect(createVersion).toHaveBeenCalledTimes(1);
    const [projectId, meta] = createVersion.mock.calls[0]!;
    expect(projectId).toBe(PROJECT);
    expect(meta).not.toHaveProperty('cadjson');
  });

  it('attaches a message when given one', async () => {
    await createCloudVersion(PROJECT, 'Created');
    expect(createVersion.mock.calls[0]![1]).toMatchObject({ message: 'Created' });
  });

  it('omits the message key entirely when absent', async () => {
    await createCloudVersion(PROJECT);
    expect(createVersion.mock.calls[0]![1]).not.toHaveProperty('message');
  });

  it('still mints a version when the thumbnail capture yields nothing', async () => {
    // Headless contexts return null; a missing picture must not cost the
    // snapshot the user asked for.
    const { captureThumbnail } = await import('./thumbnailCapture.ts');
    vi.mocked(captureThumbnail).mockResolvedValueOnce(null);
    await expect(createCloudVersion(PROJECT)).resolves.toMatchObject({ versionId: 'rev_1' });
  });
});
