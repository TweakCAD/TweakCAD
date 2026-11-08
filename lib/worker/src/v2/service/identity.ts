import { canonicalize, finest, type NamedEntity } from '@tweakcad/format';

/** A body's identity across evaluations: its name and branch (9.3). */
export function bodyIdentity(e: Pick<NamedEntity, 'ladder' | 'branch'>): string {
  return canonicalize([finest(e.ladder), e.branch]);
}
