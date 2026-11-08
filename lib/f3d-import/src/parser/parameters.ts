/**
 * Parameter records. Each holds its owner reference, the expression as text,
 * the slot it fills, its unit, its name and its solved value. The members before
 * the expression vary with the class version, so the owner reference anchors the
 * read, and the role is found by the shape of the strings that follow it.
 */

import type { DesignIndex } from './designIndex';
import { primaryRange, readPrologue, refsIn } from './designIndex';
import { ByteReader } from './byteReader';
import type { F3dParameter } from './types';

const TYPE_PARAMETER = '7A6A3D31';
const VERSION_WITH_SIX_FLAGS = 9;
/** Flags, and in some versions a u32, between the expression and the role. */
const MAX_FLAG_BYTES = 12;
const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const MAX_VALUE = 1e12;

/** A wide string with no control characters, or null. */
function textAt(bytes: Uint8Array, pos: number, end: number, maxLength: number): { text: string; next: number } | null {
  const r = new ByteReader(bytes, pos, end);
  if (r.remaining < 4) return null;
  const length = r.u32();
  if (length > maxLength || length * 2 > r.remaining) return null;
  r.pos = pos;
  const text = r.wstr();
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0xffff) return null;
  }
  return { text, next: r.pos };
}

type Tail = { role: string; unit: string; name: string; value: number; rolePos: number };

/** `wstr role, [wstr comment], wstr unit, wstr name, f64 value`, found from `start`. */
function findTail(bytes: Uint8Array, start: number, end: number): Tail | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let p = start; p + 24 < end; p++) {
    const role = textAt(bytes, p, end, 64);
    if (!role || role.text.length < 2) continue;
    for (const withComment of [true, false]) {
      let q = role.next;
      if (withComment) {
        const comment = textAt(bytes, q, end, 256);
        if (!comment) continue;
        q = comment.next;
      }
      const unit = textAt(bytes, q, end, 24);
      if (!unit) continue;
      const name = textAt(bytes, unit.next, end, 64);
      if (!name || !NAME.test(name.text) || name.next + 8 > end) continue;
      const value = view.getFloat64(name.next, true);
      if (!Number.isFinite(value) || Math.abs(value) > MAX_VALUE) continue;
      return { role: role.text, unit: unit.text, name: name.text, value, rolePos: p };
    }
  }
  return null;
}

export function readParameters(index: DesignIndex): { parameters: F3dParameter[]; unreadable: number } {
  const parameters: F3dParameter[] = [];
  let unreadable = 0;
  for (const id of index.idsOf.get(TYPE_PARAMETER) ?? []) {
    const parameter = readParameter(index, id);
    if (parameter) parameters.push(parameter);
    else unreadable++;
  }
  return { parameters, unreadable };
}

function readParameter(index: DesignIndex, id: number): F3dParameter | null {
  const range = primaryRange(index, id);
  if (!range) return null;
  try {
    const { next } = readPrologue(index, range);
    const bytes = index.bulk;
    const tail = findTail(bytes, next, range.end);
    if (!tail) return null;

    // The expression ends a few flag bytes before the role. A user parameter
    // has no owner, so the reference can't anchor this read.
    let expression: string | null = null;
    let expressionPos = -1;
    for (let p = next; p < tail.rolePos; p++) {
      const text = textAt(bytes, p, tail.rolePos, 4096);
      if (text && text.text.length > 0 && tail.rolePos - text.next <= MAX_FLAG_BYTES) {
        expression = text.text;
        expressionPos = p;
        break;
      }
    }
    if (expression === null) return null;

    const refs = refsIn(index, next, expressionPos);
    const version = index.typeOf.get(id)?.version ?? 0;
    const flagPos = tail.rolePos - (version === VERSION_WITH_SIX_FLAGS ? 2 : 1);
    return {
      id,
      name: tail.name,
      role: tail.role,
      expression,
      unit: tail.unit,
      value: tail.value,
      isUser: bytes[flagPos] === 1,
      ownerId: refs[refs.length - 1]?.id ?? null,
    };
  } catch {
    return null;
  }
}
