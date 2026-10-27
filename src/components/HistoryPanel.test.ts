/**
 * Grouping and formatting for the revision history.
 *
 * Nothing prunes revisions, so a long-lived project accumulates hundreds. A
 * flat list of timestamps is complete and unreadable; dates are how people
 * remember when they broke something. This is the logic that makes the list
 * legible, so it is the part worth pinning.
 */
import { describe, expect, it } from 'vitest';
import { groupByDay, dayKey, sizeOf } from './HistoryPanel.tsx';
import type { CloudRevision } from '../storage/cloudAdapter.ts';

function rev(createdAt: string, message: string | null = null): CloudRevision {
  return { versionId: `rev_${createdAt}`, createdAt, message, sizeBytes: 1024, authorId: null };
}

/** Local-midnight-safe timestamps: midday avoids a timezone flipping the day. */
const DAY_1_MORNING = new Date(2026, 9, 25, 9, 30).toISOString();
const DAY_1_NOON = new Date(2026, 9, 25, 12, 0).toISOString();
const DAY_2_NOON = new Date(2026, 9, 26, 12, 0).toISOString();
const DAY_3_NOON = new Date(2026, 9, 27, 12, 0).toISOString();

describe('groupByDay', () => {
  it('is empty for no revisions', () => {
    expect(groupByDay([])).toEqual([]);
  });

  it('puts same-day revisions under one header', () => {
    const groups = groupByDay([rev(DAY_1_NOON), rev(DAY_1_MORNING)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.revisions).toHaveLength(2);
  });

  it('keeps the order it was given, newest day first', () => {
    // The server returns newest-first and the cursor pagination depends on
    // that order; re-sorting here would be a second ordering to keep in
    // agreement with the first.
    const groups = groupByDay([rev(DAY_3_NOON), rev(DAY_2_NOON), rev(DAY_1_NOON)]);
    expect(groups.map(g => g.day)).toEqual([
      dayKey(DAY_3_NOON), dayKey(DAY_2_NOON), dayKey(DAY_1_NOON),
    ]);
  });

  it('starts a new group when the day changes back', () => {
    // Out-of-order input would otherwise silently merge two separate days
    // into whichever header came first.
    const groups = groupByDay([rev(DAY_2_NOON), rev(DAY_1_NOON), rev(DAY_2_NOON)]);
    expect(groups).toHaveLength(3);
  });

  it('carries every revision through exactly once', () => {
    const input = [rev(DAY_2_NOON), rev(DAY_1_NOON), rev(DAY_1_MORNING)];
    const flattened = groupByDay(input).flatMap(g => g.revisions);
    expect(flattened).toEqual(input);
  });
});

describe('sizeOf', () => {
  it.each([
    [512, '512 B'],
    [2048, '2 KB'],
    [1024 * 1024 * 3, '3.0 MB'],
  ])('%s → %s', (bytes, expected) => {
    expect(sizeOf(bytes)).toBe(expected);
  });

  it('does not report a multi-megabyte revision in bytes', () => {
    // The number that matters when deciding what is filling a quota.
    expect(sizeOf(20 * 1024 * 1024)).toBe('20.0 MB');
  });
});
