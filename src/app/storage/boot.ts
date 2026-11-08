/**
 * What a window opens at boot, with the site in the picture.
 *
 * `decideBoot` (src/storage/bootIntent.ts) settles what the window should do
 * before any storage is read: a document named in the address wins; with
 * none named, a signed-in window offers a choice rather than guessing, and a
 * window that reaches the site signed out asks first unless this tab chose
 * to work offline. This module does the reading that follows.
 *
 * A cloud project (`?project=`):
 * - signed in: the project's live document, bound to the project; a project
 *   with no document yet opens as a new document under the project's name.
 *   When it cannot be read, this browser's copy opens detached, or the
 *   window says why it did not open;
 * - signed out, or the site unreachable: this browser's copy, detached, or a
 *   new document, with a notice either way.
 * Everything else goes through the working copy (`bootDocument`).
 */
import type { IdGenerator } from '@tweakcad/editor';
import { decideBoot } from '../../storage/bootIntent.ts';
import { newDocument } from '../document';
import { CloudDocumentError, plainMessage, type CloudProjects } from './cloud';
import { bootDocument, cloudCopy, freshBoot, missingFilesNotice, type BootResult } from './session';
import { cloudRecordId, type WorkingCopyStore } from './workingCopy';

export type BootOutcome =
  | { kind: 'document'; boot: BootResult }
  /** Signed in, no document named: offer New project, Open and Open file. */
  | { kind: 'choose' }
  /** The site is there, nobody is signed in, no document named: ask first. */
  | { kind: 'gate' }
  /** The named cloud project could not be read and this browser has no copy of it. */
  | { kind: 'load-failed'; message: string };

export interface ResolveBootOptions {
  workingCopy: WorkingCopyStore;
  /** `?local=`. */
  localId: string | null;
  /** `?project=`. */
  projectId: string | null;
  /** `?reset`: wipe the working copy and start blank. */
  reset: boolean;
  ids: IdGenerator;
  name: () => string;
  saas: { reachable: boolean; signedIn: boolean };
  /** This tab answered the sign-in question with "continue offline". */
  offlineChosen: boolean;
  cloud: CloudProjects | null;
}

/** Why a cloud project did not open, worded for the person who asked for it. */
export function describeCloudLoadError(err: unknown): string {
  if (err instanceof CloudDocumentError) return err.message;
  if (err instanceof TypeError) return 'The server could not be reached.';
  const raw = err instanceof Error ? err.message : String(err);
  if (/^not_found: /.test(raw)) return 'The project was not found in your account.';
  const message = plainMessage(err);
  if (!message) return 'The project could not be read.';
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

export async function resolveBoot(o: ResolveBootOptions): Promise<BootOutcome> {
  if (o.reset) return { kind: 'document', boot: await bootDocument({ ...o, localId: null, reset: true }) };
  const intent = decideBoot({
    hasProjectId: o.projectId !== null,
    hasLocalId: o.localId !== null,
    saas: o.saas,
    offlineChosen: o.offlineChosen,
  });
  if (intent.kind === 'choose') return { kind: 'choose' };
  if (intent.kind === 'gate') return { kind: 'gate' };
  if (o.projectId === null) return { kind: 'document', boot: await bootDocument({ ...o, reset: false }) };

  const projectId = o.projectId;
  if (!o.saas.reachable || !o.saas.signedIn || !o.cloud) {
    const why = !o.saas.reachable || !o.cloud ? 'The cloud is not reachable.' : 'Sign in to open this cloud project.';
    const copy = await cloudCopy(o.workingCopy, projectId, why);
    if (copy) return { kind: 'document', boot: copy };
    return {
      kind: 'document',
      boot: freshBoot(o, {
        message:
          !o.saas.reachable || !o.cloud
            ? 'The cloud is not reachable and this browser has no copy of that project.'
            : why,
      }),
    };
  }

  try {
    const opened = await o.cloud.open(projectId);
    return {
      kind: 'document',
      boot: {
        doc: opened.doc ?? newDocument({ ids: o.ids, name: opened.name }),
        localId: cloudRecordId(projectId),
        storage: { kind: 'cloud', projectId, name: opened.name },
        session: { kind: 'cloud', projectId, name: opened.name },
        ...(opened.missing.length > 0 ? { notice: missingFilesNotice(opened.missing) } : {}),
      },
    };
  } catch (err) {
    console.warn('[boot] the cloud project did not open', err);
    const reason = describeCloudLoadError(err);
    const copy = await cloudCopy(o.workingCopy, projectId, `The cloud project didn't open: ${reason}`);
    if (copy) return { kind: 'document', boot: copy };
    return { kind: 'load-failed', message: reason };
  }
}
