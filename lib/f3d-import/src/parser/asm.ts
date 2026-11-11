/**
 * An ASM B-rep stream read in full: every record with its class chain and its
 * values in order, nested subtype blocks kept as nested lists. The topology and
 * geometry readers work on these records by position.
 *
 * A stream is a magic (`ASM BinaryFile4` or `ASM BinaryFile8`, the digit giving
 * the width of integers and pointers), a fixed header, then tagged values
 * grouped into records that each end with a terminator. Record 0 is the header
 * record; pointers count records from it, except that a history section sits
 * outside the numbering.
 */

import { F3dFormatError } from './byteReader';

export type Vec3 = [number, number, number];

/** One value of a record. */
export type Item =
  | { t: 'int'; v: number }
  | { t: 'f64'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'ref'; v: number }
  | { t: 'pos'; v: Vec3 }
  | { t: 'vec'; v: Vec3 }
  | { t: 'enum'; v: number }
  | { t: 'uv'; v: [number, number] }
  | { t: 'sub'; v: Item[] };

export type AsmRecord = {
  /** Class chain, most derived first, e.g. `['cone', 'surface']`. */
  classes: string[];
  items: Item[];
};

export type AsmStream = {
  /** Records in pointer order: index 0 is the header record. */
  records: AsmRecord[];
  /** Records 1 up to this index are the stream's top-level entities. */
  entityCount: number;
};

const decoder = new TextDecoder('utf-8');

const MAGIC_8 = 'ASM BinaryFile8';
const MAGIC_4 = 'ASM BinaryFile4';

/** Tokens of a stream, as records. */
function readRecords(bytes: Uint8Array): { records: AsmRecord[]; entityCount: number } {
  const magic = new TextDecoder('latin1').decode(bytes.subarray(0, 15));
  const width = magic === MAGIC_8 ? 8 : magic === MAGIC_4 ? 4 : 0;
  if (width === 0) throw new F3dFormatError('Unknown B-rep stream');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 47) throw new F3dFormatError('Truncated B-rep header');
  const entityCount = width === 8 ? Number(view.getBigUint64(31, true)) : view.getUint32(23, true);
  let p = width === 8 ? 47 : 31;

  const integer = (at: number): number => (width === 8 ? Number(view.getBigInt64(at, true)) : view.getInt32(at, true));
  const need = (n: number): void => {
    if (p + n > bytes.length) throw new F3dFormatError('Truncated B-rep stream');
  };

  const records: AsmRecord[] = [];
  let current: AsmRecord = { classes: [], items: [] };
  const stack: Item[][] = [];
  let items = current.items;
  const end = bytes.length;

  while (p < end) {
    const tag = bytes[p++] as number;
    switch (tag) {
      case 0x02:
        need(1);
        items.push({ t: 'int', v: bytes[p] as number });
        p += 1;
        break;
      case 0x03:
        need(2);
        items.push({ t: 'int', v: view.getInt16(p, true) });
        p += 2;
        break;
      case 0x04:
        need(width);
        items.push({ t: 'int', v: integer(p) });
        p += width;
        break;
      case 0x05:
        need(4);
        items.push({ t: 'f64', v: view.getFloat32(p, true) });
        p += 4;
        break;
      case 0x06:
        need(8);
        items.push({ t: 'f64', v: view.getFloat64(p, true) });
        p += 8;
        break;
      case 0x07:
      case 0x0d:
      case 0x0e:
      case 0x08:
      case 0x09:
      case 0x12: {
        let length: number;
        if (tag === 0x08) {
          need(2);
          length = view.getUint16(p, true);
          p += 2;
        } else if (tag === 0x09 || tag === 0x12) {
          need(width);
          length = width === 8 ? Number(view.getBigUint64(p, true)) : view.getUint32(p, true);
          p += width;
        } else {
          need(1);
          length = bytes[p++] as number;
        }
        need(length);
        const text = decoder.decode(bytes.subarray(p, p + length));
        p += length;
        if ((tag === 0x0d || tag === 0x0e) && stack.length === 0) current.classes.push(text);
        else items.push({ t: 'str', v: text });
        break;
      }
      case 0x0a:
        items.push({ t: 'bool', v: true });
        break;
      case 0x0b:
        items.push({ t: 'bool', v: false });
        break;
      case 0x0c:
        need(width);
        items.push({ t: 'ref', v: integer(p) });
        p += width;
        break;
      case 0x0f: {
        const inner: Item[] = [];
        items.push({ t: 'sub', v: inner });
        stack.push(items);
        items = inner;
        break;
      }
      case 0x10:
        if (stack.length === 0) throw new F3dFormatError('Unbalanced B-rep subtype');
        items = stack.pop() as Item[];
        break;
      case 0x11:
        if (stack.length > 0) throw new F3dFormatError('B-rep record ends inside a subtype');
        records.push(current);
        current = { classes: [], items: [] };
        items = current.items;
        break;
      case 0x13:
      case 0x14:
        need(24);
        items.push({
          t: tag === 0x13 ? 'pos' : 'vec',
          v: [view.getFloat64(p, true), view.getFloat64(p + 8, true), view.getFloat64(p + 16, true)],
        });
        p += 24;
        break;
      case 0x15:
        need(width);
        items.push({ t: 'enum', v: integer(p) });
        p += width;
        break;
      case 0x16:
        need(16);
        items.push({ t: 'uv', v: [view.getFloat64(p, true), view.getFloat64(p + 8, true)] });
        p += 16;
        break;
      case 0x17:
        need(8);
        items.push({ t: 'int', v: Number(view.getBigInt64(p, true)) });
        p += 8;
        break;
      default:
        throw new F3dFormatError(`Unknown B-rep token ${tag}`);
    }
  }
  if (current.classes.length > 0 || current.items.length > 0) records.push(current);
  return { records, entityCount };
}

/** Records in pointer order: the history section is left out, the snapshot after it too. */
export function readAsm(bytes: Uint8Array): AsmStream {
  const { records, entityCount } = readRecords(bytes);
  const out: AsmRecord[] = [];
  for (const record of records) {
    if (record.classes[0] === 'Begin' && record.classes.includes('History')) break;
    if (record.classes[0] === 'End-of-ASM-data' || (record.classes[0] === 'End' && record.classes[2] === 'ASM')) break;
    out.push(record);
  }
  return { records: out, entityCount };
}
