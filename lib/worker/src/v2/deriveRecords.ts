/**
 * What each live `core.derive` of a part built: where it put the derived
 * bodies and the plane it reflected them in, so an opposite-hand assembly
 * mirror (12.1) can place an instance of that part as the mirror image.
 */
import type { Plane, Rigid } from './rigid';

export interface DeriveRecord {
  feature: string;
  /** The derive's frame in its part: the source's frame lands there. */
  frame: Rigid;
  /** The plane of the part the derived bodies were then reflected in. */
  mirror?: Plane;
}

const records = new WeakMap<object, DeriveRecord[]>();

export function recordDerive(part: object, record: DeriveRecord): void {
  records.set(part, [...(records.get(part) ?? []), record]);
}

export function deriveRecordsOf(part: object): readonly DeriveRecord[] {
  return records.get(part) ?? [];
}
