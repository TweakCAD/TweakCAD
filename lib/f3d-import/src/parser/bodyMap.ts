/**
 * Where a design body's shape is stored: a body-map record names a B-rep
 * stream file and pairs each body record it covers with a selector into that
 * stream. The record's layout differs between generations, so it is found by
 * its parts: the file name, written as a u32 character count and UTF-16LE text
 * (`BREP.<uuid>.smb` or `.smbh`), and before it a u32 count and that many pairs
 * of u64 selector and u64 body record id.
 *
 * A selector names the stream's body whose key equals it, or else the body at
 * that place among the stream's bodies that are not sketch regions.
 */
import type { DesignIndex } from './designIndex';

export type BodySource = { stream: string; selector: number };

const TYPE_BODY = 'D3937028';
const NEEDLE = [...'BREP.'].flatMap((c) => [c.charCodeAt(0), 0]);
const MAX_PAIRS = 100_000;

export function readBodyMap(index: DesignIndex): Map<number, BodySource> {
  const bulk = index.bulk;
  const view = new DataView(bulk.buffer, bulk.byteOffset, bulk.byteLength);
  const isBody = (id: number) => index.typeOf.get(id)?.key === TYPE_BODY;
  const starts = [...index.primary.values()].sort((a, b) => a - b);
  const out = new Map<number, BodySource>();

  const recordStart = (at: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] as number) <= at) {
        found = starts[mid] as number;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };

  for (let p = 4; p + NEEDLE.length <= bulk.length; p++) {
    if (bulk[p] !== 0x42) continue;
    let hit = true;
    for (let i = 1; i < NEEDLE.length; i++)
      if (bulk[p + i] !== NEEDLE[i]) {
        hit = false;
        break;
      }
    if (!hit) continue;
    const chars = view.getUint32(p - 4, true);
    if (chars < 5 || chars > 200 || p + chars * 2 > bulk.length) continue;
    let name = '';
    for (let i = 0; i < chars; i++) name += String.fromCharCode(view.getUint16(p + i * 2, true));
    if (!/^BREP\.[0-9a-fA-F-]+\.smbh?$/.test(name)) continue;
    const start = recordStart(p);
    if (start < 0) continue;
    // The pairs end before the name; find the count that fits them.
    for (let o = start; o + 4 <= p - 4; o++) {
      const n = view.getUint32(o, true);
      if (n < 1 || n > MAX_PAIRS || o + 4 + n * 16 > p - 4) continue;
      const pairs: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const at = o + 4 + i * 16;
        const selector = Number(view.getBigInt64(at, true));
        const body = Number(view.getBigUint64(at + 8, true));
        if (!isBody(body)) break;
        pairs.push([selector, body]);
      }
      if (pairs.length !== n) continue;
      for (const [selector, body] of pairs) if (!out.has(body)) out.set(body, { stream: name, selector });
      break;
    }
    p += chars * 2 - 1;
  }
  return out;
}
