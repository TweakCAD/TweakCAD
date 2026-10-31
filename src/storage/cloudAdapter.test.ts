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
import type { CadProject } from '@tweakcad/core/src/document/schema.ts';

// The provider is the seam: stub it so these tests cover OUR adapter logic —
// etag bookkeeping and which endpoint gets called — not HTTP.
const save = vi.fn();
const listRevisions = vi.fn();
const restoreRevision = vi.fn();
const putReference = vi.fn();
const referenceUrl = vi.fn();
const createVersion = vi.fn();
const load = vi.fn();
const loadDocument = vi.fn();

class StubConflictError extends Error {}

vi.mock('@tweakcad/cloud-providers', () => ({
  CloudStorageProvider: class {
    save = save;
    listRevisions = listRevisions;
    restoreRevision = restoreRevision;
    putReference = putReference;
    referenceUrl = referenceUrl;
    createVersion = createVersion;
    load = load;
    loadDocument = loadDocument;
  },
  CloudConflictError: StubConflictError,
}));

vi.mock('./thumbnailCapture.ts', () => ({
  captureThumbnail: vi.fn(async () => null),
}));

const {
  saveCloudProject, createCloudVersion, clearCloudEtag,
  wouldExceedCloudLimit, CLOUD_DOCUMENT_MAX_BYTES,
  listCloudRevisions, restoreCloudRevision,
  splitReferenceAssets, hydrateReferenceAssets, loadCloudProject,
} = await import('./cloudAdapter.ts');
const { newProjectWithPart } = await import('@tweakcad/core/src/document/factory.ts');

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

describe('wouldExceedCloudLimit', () => {
  /**
   * The free tier's storage line (saas-architecture.md §17). This decides
   * whether the user is warned *before* an import rather than discovering at
   * the next autosave that their project stopped syncing — after they have
   * already positioned and modelled against the geometry.
   *
   * Advisory only: the server enforces. These pin that the estimate counts
   * both halves, because counting only the payload would wave through an
   * import that is individually fine and collectively over.
   */
  function docOfRoughly(bytes: number): CadProject {
    // `parts` is the only field big enough to pad without tripping the type.
    return { metadata: { name: 'x'.repeat(Math.max(0, bytes - 40)) } } as unknown as CadProject;
  }

  it('passes an import that fits', () => {
    expect(wouldExceedCloudLimit(docOfRoughly(1000), 1000)).toBe(false);
  });

  it('rejects a payload that busts the limit on its own', () => {
    expect(wouldExceedCloudLimit(docOfRoughly(1000), CLOUD_DOCUMENT_MAX_BYTES + 1)).toBe(true);
  });

  it('counts the existing document, not just the new payload', () => {
    // The case a payload-only check would miss: a project already near the
    // line plus a second import that is individually unremarkable.
    const nearLimit = docOfRoughly(CLOUD_DOCUMENT_MAX_BYTES - 1000);
    expect(wouldExceedCloudLimit(nearLimit, 100)).toBe(false);
    expect(wouldExceedCloudLimit(nearLimit, 5000)).toBe(true);
  });

  it('is the same number the server enforces', () => {
    // Duplicated across repos on purpose (the warning must work offline), so
    // this is the reminder that moving one means moving the other.
    expect(CLOUD_DOCUMENT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('restoreCloudRevision — etag bookkeeping', () => {
  /**
   * A restore replaces the live document, so the etag this module has cached
   * is stale the instant it returns. If it is not adopted, the next autosave
   * sends it as `If-Match` and the server rejects — the user sees a conflict
   * immediately after fixing their document, which is the one moment they
   * least expect one and least deserve one.
   */
  it('adopts the etag the restore returns, so the next autosave is clean', async () => {
    await saveCloudProject(PROJECT, doc());            // caches etag-1
    restoreRevision.mockResolvedValue({
      etag: 'etag-after-restore',
      restoredFrom: 'rev_old',
      snapshotVersionId: 'rev_snapshot',
    });

    await restoreCloudRevision(PROJECT, 'rev_old');
    await saveCloudProject(PROJECT, doc());

    // The save after the restore must state the RESTORED etag, not the one
    // from before it.
    expect(save.mock.calls.at(-1)?.[2]).toEqual({ ifMatch: 'etag-after-restore' });
  });

  it('sends the cached etag as the restore precondition', async () => {
    // Between listing history and choosing from it, another tab may have
    // moved the document. Restoring over that is the same last-write-wins
    // bug the autosave precondition exists to prevent.
    await saveCloudProject(PROJECT, doc());
    restoreRevision.mockResolvedValue({
      etag: 'e2', restoredFrom: 'rev_old', snapshotVersionId: 'rev_s',
    });

    await restoreCloudRevision(PROJECT, 'rev_old');
    expect(restoreRevision).toHaveBeenCalledWith(PROJECT, 'rev_old', { ifMatch: 'etag-1' });
  });

  it('sends a null precondition when nothing is cached yet', async () => {
    // Opening the history straight after load, before any save this session.
    restoreRevision.mockResolvedValue({
      etag: 'e2', restoredFrom: 'rev_old', snapshotVersionId: 'rev_s',
    });
    await restoreCloudRevision(PROJECT, 'rev_old');
    expect(restoreRevision).toHaveBeenCalledWith(PROJECT, 'rev_old', { ifMatch: null });
  });

  it('hands back the snapshot id so the UI can offer to undo the restore', async () => {
    restoreRevision.mockResolvedValue({
      etag: 'e2', restoredFrom: 'rev_old', snapshotVersionId: 'rev_before',
    });
    const result = await restoreCloudRevision(PROJECT, 'rev_old');
    expect(result.snapshotVersionId).toBe('rev_before');
  });
});

describe('listCloudRevisions', () => {
  it('passes paging through untouched', async () => {
    listRevisions.mockResolvedValue({ items: [], nextCursor: null });
    await listCloudRevisions(PROJECT, { cursor: '2026-01-01T00:00:00.000Z', limit: 10 });
    expect(listRevisions).toHaveBeenCalledWith(PROJECT, {
      cursor: '2026-01-01T00:00:00.000Z',
      limit: 10,
    });
  });
});

describe('splitReferenceAssets', () => {
  /**
   * A `ref` import keeps its bytes inside the document so a file on disk stays
   * self-contained. For the cloud that is exactly wrong: the bytes would be
   * re-uploaded on every autosave and copied into every revision. These pin
   * that the split takes the bytes out and loses nothing else.
   */
  function docWithRef(bytes: string | undefined): CadProject {
    return {
      schemaVersion: 1,
      metadata: { name: 'x' },
      references: {
        ref_1: {
          id: 'ref_1', name: 'bracket.step', type: 'step',
          sizeBytes: 4, hash: 'abc123',
          ...(bytes === undefined ? {} : { bytes }),
        },
      },
    } as unknown as CadProject;
  }

  it('takes the bytes out of the document', () => {
    const { stripped, assets } = splitReferenceAssets(docWithRef('QUJDRA=='));
    expect(stripped.references.ref_1!.bytes).toBeUndefined();
    expect(assets).toEqual([{ hash: 'abc123', base64: 'QUJDRA==' }]);
  });

  it('keeps everything that describes the file', () => {
    // The entry still has to name the import before the bytes come back, or
    // the UI has nothing to show while loading.
    const { stripped } = splitReferenceAssets(docWithRef('QUJDRA=='));
    expect(stripped.references.ref_1).toMatchObject({
      id: 'ref_1', name: 'bracket.step', type: 'step', sizeBytes: 4, hash: 'abc123',
    });
  });

  it('has nothing to upload when the bytes are already absent', () => {
    // Saving a document that was loaded from the cloud: the assets are
    // already up there, and re-uploading them every autosave is the cost
    // this whole mechanism exists to avoid.
    const { assets } = splitReferenceAssets(docWithRef(undefined));
    expect(assets).toEqual([]);
  });

  it('leaves a document with no references alone', () => {
    const doc = { schemaVersion: 1, references: {} } as unknown as CadProject;
    const { stripped, assets } = splitReferenceAssets(doc);
    expect(assets).toEqual([]);
    expect(stripped.references).toEqual({});
  });

  it('does not mutate the document it was given', () => {
    // The live document is Immer-frozen; stripping in place would throw, and
    // the editor would lose the bytes it still needs to rebuild.
    const doc = docWithRef('QUJDRA==');
    splitReferenceAssets(doc);
    expect(doc.references.ref_1!.bytes).toBe('QUJDRA==');
  });
});

describe('hydrateReferenceAssets', () => {
  it('returns the document untouched when there are no references', async () => {
    const doc = { schemaVersion: 1, references: {} } as unknown as CadProject;
    expect(await hydrateReferenceAssets(PROJECT, doc)).toBe(doc);
  });

  it('leaves an entry alone when it already carries its bytes', async () => {
    // A document straight off disk. Fetching what we already hold would be a
    // round trip for nothing.
    const doc = {
      schemaVersion: 1,
      references: {
        ref_1: { id: 'ref_1', name: 'a.step', type: 'step', sizeBytes: 4, hash: 'h', bytes: 'QQ==' },
      },
    } as unknown as CadProject;
    const out = await hydrateReferenceAssets(PROJECT, doc);
    expect(out.references.ref_1!.bytes).toBe('QQ==');
    expect(referenceUrl).not.toHaveBeenCalled();
  });

  it('survives an asset it cannot fetch, costing one import not the document', async () => {
    referenceUrl.mockRejectedValue(new Error('gone'));
    const doc = {
      schemaVersion: 1,
      references: {
        ref_1: { id: 'ref_1', name: 'a.step', type: 'step', sizeBytes: 4, hash: 'h' },
      },
    } as unknown as CadProject;
    const out = await hydrateReferenceAssets(PROJECT, doc);
    expect(out.references.ref_1!.bytes).toBeUndefined();
    expect(out.references.ref_1!.name).toBe('a.step');
  });
});

describe('reference uploads — not on every save', () => {
  /**
   * The bug these exist for: `hydrateReferenceAssets` puts the bytes back into
   * the document on load, so every subsequent autosave offered them again and
   * `putReference` sent the whole body before the server could say it already
   * had it. A 20 MB import on a two-second debounce meant 20 MB per save —
   * precisely the bandwidth cost the reference mechanism removes.
   */
  function docWithAsset(hash: string, bytes: string | undefined): CadProject {
    return {
      schemaVersion: 1,
      metadata: { name: 'x' },
      references: {
        ref_1: {
          id: 'ref_1', name: 'big.step', type: 'step',
          sizeBytes: 3, hash,
          ...(bytes === undefined ? {} : { bytes }),
        },
      },
    } as unknown as CadProject;
  }

  it('uploads an asset the first time it is saved', async () => {
    await saveCloudProject('p_upload_1', docWithAsset('h_new_1', 'QUJD'));
    expect(putReference).toHaveBeenCalledTimes(1);
    expect(putReference.mock.calls[0]?.[1]).toBe('h_new_1');
  });

  it('does not upload it again on the next save', async () => {
    const doc = docWithAsset('h_new_2', 'QUJD');
    await saveCloudProject('p_upload_2', doc);
    await saveCloudProject('p_upload_2', doc);
    await saveCloudProject('p_upload_2', doc);
    expect(putReference).toHaveBeenCalledTimes(1);
  });

  it('does not upload an asset it just fetched', async () => {
    // Load hydrates the bytes back in; the save that follows must not send
    // them straight back up.
    referenceUrl.mockResolvedValue('https://blob.example/h_hydrated');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([65, 66, 67]).buffer,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const hydrated = await hydrateReferenceAssets(
      'p_upload_3', docWithAsset('h_hydrated', undefined),
    );
    expect(hydrated.references.ref_1!.bytes).toBeDefined();

    await saveCloudProject('p_upload_3', hydrated);
    expect(putReference).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('tracks assets per project, not globally', async () => {
    // Two projects can reference the same file; the bytes live under each
    // project's own prefix, so knowing one has it says nothing about the
    // other.
    const doc = docWithAsset('h_shared', 'QUJD');
    await saveCloudProject('p_upload_4a', doc);
    await saveCloudProject('p_upload_4b', doc);
    expect(putReference).toHaveBeenCalledTimes(2);
  });

  it('still strips the bytes from what is stored', async () => {
    // The skip must not quietly turn into "leave them in the document".
    await saveCloudProject('p_upload_5', docWithAsset('h_new_5', 'QUJD'));
    const sent = save.mock.calls.at(-1)?.[1] as Blob;
    const text = await sent.text();
    expect(text).not.toContain('QUJD');
    expect(text).toContain('big.step');
  });
});

describe('loadCloudProject', () => {
  const summary = { project: { name: 'Enclosure' }, downloadUrl: 'https://bucket.example/doc', etag: 'etag-meta', sizeBytes: 10 };

  it('reads the document through the app, not the signed bucket URL', async () => {
    // The signed URL is cross-origin; fetching it needs bucket CORS, and a
    // blocked read is a project that will not open.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    load.mockResolvedValue(summary);
    loadDocument.mockResolvedValue({ document: newProjectWithPart('Enclosure', 'Part 1'), etag: 'etag-doc' });

    const result = await loadCloudProject(PROJECT);

    expect(loadDocument).toHaveBeenCalledWith(PROJECT);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result?.doc.metadata.name).toBe('Enclosure');
    fetchSpy.mockRestore();
  });

  it('seeds the save precondition from the bytes it was served', async () => {
    load.mockResolvedValue(summary);
    loadDocument.mockResolvedValue({ document: newProjectWithPart('Enclosure', 'Part 1'), etag: 'etag-doc' });
    const result = await loadCloudProject(PROJECT);
    expect(result?.etag).toBe('etag-doc');

    await saveCloudProject(PROJECT, doc());
    expect(save.mock.calls[0]![2]).toEqual({ ifMatch: 'etag-doc' });
  });

  it('has no document to read for a project that was never saved', async () => {
    load.mockResolvedValue({ ...summary, downloadUrl: null, etag: null });
    const result = await loadCloudProject(PROJECT);
    expect(result?.doc).toBeNull();
    expect(loadDocument).not.toHaveBeenCalled();
  });

  it('throws when the document cannot be read, rather than returning nothing', async () => {
    load.mockResolvedValue(summary);
    loadDocument.mockRejectedValue(new Error('internal: The project document is unavailable.'));
    await expect(loadCloudProject(PROJECT)).rejects.toThrow('unavailable');
  });
});
