/**
 * The Size and Designation rows of a thread: the nominal size, then the
 * designations of that size, the coarse pitch first and the fine pitches
 * after it. Both rows edit the one stored designation.
 */
import { ISO_METRIC, threadSize } from '@tweakcad/worker/src/v2/threadTable';
import { Select } from './panelKit';
import { designationOfSize, designationsFor, sizeOf, THREAD_SIZES } from './thread';

/** A designation as the list shows it, with its pitch: the coarse `M8` reads `M8x1.25`. */
export function designationLabel(designation: string): string {
  if (designation.includes('x')) return designation;
  try {
    return `${designation}x${threadSize(ISO_METRIC, designation).pitch}`;
  } catch {
    return designation;
  }
}

export function ThreadSizeRows({
  designation,
  bound,
  onChange,
}: {
  designation: string;
  bound: string | null;
  onChange: (designation: string) => void;
}) {
  const size = sizeOf(designation);
  return (
    <>
      <Select
        label="Size"
        value={size === null ? designation : String(size)}
        options={THREAD_SIZES.map((s) => ({ id: String(s), label: String(s) }))}
        bound={bound}
        onChange={(picked) => onChange(designationOfSize(Number(picked)))}
      />
      <Select
        label="Designation"
        value={designation}
        options={designationsFor(designation).map((d) => ({ id: d, label: designationLabel(d) }))}
        onChange={onChange}
      />
    </>
  );
}
