/**
 * The site's project API over memory, for tests: etags, stored files and
 * revisions behave as the site's do, and it reads its own signed URLs.
 */
import { CloudConflictError, type CloudApi, type CloudRevision } from './cloud';

interface FakeProject {
  name: string;
  text: string | null;
  etag: number;
  revisions: (CloudRevision & { text: string })[];
}

export class FakeSite implements CloudApi {
  readonly projects = new Map<string, FakeProject>();
  readonly files = new Map<string, Uint8Array>();
  readonly uploads: string[] = [];
  readonly renames: string[] = [];
  readonly ifMatch: (string | null | undefined)[] = [];
  /** The thumbnail each revision was created with, oldest first. */
  readonly thumbnails: (Blob | null | undefined)[] = [];
  /** How many of the next saves fail as a network failure would. */
  offline = 0;
  private count = 0;

  private project(id: string): FakeProject {
    const p = this.projects.get(id);
    if (!p) throw Object.assign(new Error('not_found: Project not found.'), { code: 'not_found' });
    return p;
  }

  list() {
    return Promise.resolve({ items: [...this.projects.values()].map((p) => ({ name: p.name })) });
  }

  create(input: { name: string }) {
    const id = `proj_${++this.count}`;
    this.projects.set(id, { name: input.name, text: null, etag: 0, revisions: [] });
    return Promise.resolve({ id, slug: id, name: input.name });
  }
  rename(id: string, n: string) {
    this.project(id).name = n;
    this.renames.push(n);
    return Promise.resolve({});
  }
  load(id: string) {
    const p = this.project(id);
    return Promise.resolve({
      project: { name: p.name },
      hasDocument: p.text !== null,
      etag: p.text === null ? null : `e${p.etag}`,
    });
  }
  loadDocument(id: string) {
    const p = this.project(id);
    return Promise.resolve({ text: p.text ?? '', etag: `e${p.etag}` });
  }
  async save(id: string, blob: Blob, meta: { ifMatch?: string | null }) {
    const p = this.project(id);
    this.ifMatch.push(meta.ifMatch);
    if (this.offline > 0) {
      this.offline--;
      throw new TypeError('Failed to fetch');
    }
    if (meta.ifMatch && meta.ifMatch !== `e${p.etag}`)
      throw new CloudConflictError('This project changed somewhere else.');
    p.text = await blob.text();
    p.etag++;
    return { etag: `e${p.etag}`, savedAt: '2026-11-06T10:00:00Z' };
  }
  /** Another tab writes the project. */
  writeElsewhere(id: string, text: string): void {
    const p = this.project(id);
    p.text = text;
    p.etag++;
  }
  createVersion(id: string, meta: { message?: string; thumbnail?: Blob | null }) {
    const p = this.project(id);
    this.thumbnails.push(meta.thumbnail);
    const versionId = `rev_${++this.count}`;
    p.revisions.unshift({
      versionId,
      createdAt: '2026-11-06T10:00:00Z',
      message: meta.message ?? null,
      sizeBytes: p.text?.length ?? 0,
      authorId: null,
      text: p.text ?? '',
    });
    return Promise.resolve({ versionId, createdAt: '2026-11-06T10:00:00Z' });
  }
  listRevisions(id: string) {
    return Promise.resolve({ items: this.project(id).revisions.map(({ text: _text, ...r }) => r), nextCursor: null });
  }
  loadRevision(id: string, revisionId: string) {
    const r = this.projects.get(id)?.revisions.find((x) => x.versionId === revisionId);
    return r ? Promise.resolve(r.text) : Promise.reject(new Error('not_found: Revision not found.'));
  }
  async restoreRevision(id: string, revisionId: string, opts: { ifMatch?: string | null }) {
    const p = this.project(id);
    if (opts.ifMatch && opts.ifMatch !== `e${p.etag}`) throw new CloudConflictError('moved');
    const rev = p.revisions.find((r) => r.versionId === revisionId);
    if (!rev) throw new Error('not_found: Revision not found.');
    const snapshot = await this.createVersion(id, { message: 'Before restore' });
    p.text = rev.text;
    p.etag++;
    return { etag: `e${p.etag}`, snapshotVersionId: snapshot.versionId };
  }
  putReference(id: string, hash: string, body: Uint8Array) {
    this.project(id);
    this.files.set(`${id}/${hash}`, body);
    this.uploads.push(hash);
    return Promise.resolve();
  }
  loadReference(id: string, hash: string) {
    const b = this.files.get(`${id}/${hash}`);
    return b ? Promise.resolve(b) : Promise.reject(new Error('not_found: Reference not found.'));
  }
}
