/**
 * A pick list's labels told apart: labels that repeat are numbered in list
 * order ("Edge 1 of Body 4", "Edge 2 of Body 4"); the others are kept.
 */
export function distinctLabels(labels: readonly string[]): string[] {
  const total = new Map<string, number>();
  for (const l of labels) total.set(l, (total.get(l) ?? 0) + 1);
  const seen = new Map<string, number>();
  return labels.map((l) => {
    if ((total.get(l) ?? 0) < 2) return l;
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    const m = /^(\S+)( of .*)$/.exec(l);
    return m ? `${m[1]} ${n}${m[2]}` : `${l} ${n}`;
  });
}
