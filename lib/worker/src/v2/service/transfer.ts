/** Every buffer under `v`, once each, to transfer rather than copy; one walk, whatever the number of buffers. */
export function buffers(v: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const walk = (x: unknown): void => {
    if (ArrayBuffer.isView(x)) {
      if (x.buffer instanceof ArrayBuffer) out.add(x.buffer);
    } else if (Array.isArray(x)) for (const item of x) walk(item);
    else if (x !== null && typeof x === 'object') for (const item of Object.values(x)) walk(item);
  };
  walk(v);
  return [...out];
}
