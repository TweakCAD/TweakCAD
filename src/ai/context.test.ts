import { describe, expect, it } from 'vitest';
import { ToolError, checkCanEdit, type AiContext } from './context';

/** A context whose editor shows a read-only document or not, with no panel open. */
const ctx = (readOnly: boolean) =>
  ({
    services: {
      editor: { store: { readOnly } },
      scheduler: { previewing: false },
      app: { getState: () => ({ panel: null }) },
    },
  }) as unknown as AiContext;

describe('the editing tools', () => {
  it('are refused while the app shows a revision read-only', () => {
    expect(() => checkCanEdit(ctx(false))).not.toThrow();
    let refusal: unknown;
    try {
      checkCanEdit(ctx(true));
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(ToolError);
    expect((refusal as ToolError).code).toBe('REFUSED');
    expect((refusal as ToolError).message).toContain('read-only');
  });
});
