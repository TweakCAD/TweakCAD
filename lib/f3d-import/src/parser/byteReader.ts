/**
 * Bounds-checked little-endian reader. Every read and every declared length is
 * checked against the end of the range, because `.f3d` files are untrusted
 * input and their counts come straight from the file.
 */

export class F3dFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'F3dFormatError';
  }
}

const latin1 = new TextDecoder('latin1');
const utf16 = new TextDecoder('utf-16le');

export class ByteReader {
  private readonly view: DataView;
  pos: number;
  readonly end: number;

  constructor(
    readonly bytes: Uint8Array,
    pos = 0,
    end = bytes.length,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
    this.end = Math.min(end, bytes.length);
  }

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.end) {
      throw new F3dFormatError(`Read of ${n} bytes past the end of the range at ${this.pos}`);
    }
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++] as number;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** u64 as a number. Record ids and offsets stay far below 2^53; larger is corrupt. */
  u64(): number {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new F3dFormatError(`u64 out of range at ${this.pos - 8}`);
    return Number(v);
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  /** u32 byte count, then single-byte text. */
  str8(): string {
    const n = this.u32();
    this.need(n);
    const s = latin1.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  /** u32 code-unit count, then UTF-16LE text. */
  wstr(): string {
    const n = this.u32();
    this.need(n * 2);
    const s = utf16.decode(this.bytes.subarray(this.pos, this.pos + n * 2));
    this.pos += n * 2;
    return s;
  }

  /** A count that must fit in what is left, at `minItemBytes` per item. */
  count(minItemBytes: number): number {
    const n = this.u32();
    if (n * minItemBytes > this.remaining) {
      throw new F3dFormatError(`Count ${n} exceeds the remaining ${this.remaining} bytes`);
    }
    return n;
  }
}
