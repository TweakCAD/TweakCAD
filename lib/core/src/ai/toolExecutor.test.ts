/**
 * Tests for the tool executor + ToolHost contract.
 *
 * Uses a hand-rolled FakeHost so we can exercise every tool in
 * isolation. The real browser host gets its own integration tests
 * at the chat-panel level. Server-side tests use the same FakeHost
 * pattern.
 */
import { describe, expect, it, vi } from 'vitest';
import { newProjectWithPart, emptyParameterTable } from '../document/factory.ts';
import type { CadProject } from '../document/schema.ts';
import type { PartId } from '../ids.ts';
import { partId, featureId } from '../ids.ts';
import { executeTool, type ToolHost } from './toolExecutor.ts';
import { CAD_TOOLS, findTool, isToolName } from '@tweakcad/cad-tools';

// --- Fake host -----------------------------------------------------------

type FakeHostOpts = {
  doc?: CadProject;
  dispatch?: (cmd: unknown) => Promise<unknown>;
  diagnostics?: unknown;
};

function makeFakeHost(opts: FakeHostOpts = {}): { host: ToolHost; transactions: string[] } {
  let doc = opts.doc ?? newProjectWithPart('Test');
  const transactions: string[] = [];
  const host: ToolHost = {
    getDocument: () => doc,
    getDiagnostics: () => opts.diagnostics ?? { diagnostics: [], featureResults: {} },
    dispatchCommand: async (cmd) => {
      if (opts.dispatch) return opts.dispatch(cmd);
      // Default: mark doc as "dispatched" so callers can verify state was returned.
      doc = { ...doc, metadata: { ...doc.metadata, name: 'dispatched' } };
      return doc;
    },
    beginTransaction: async (label) => { transactions.push(`begin:${label}`); },
    endTransaction: async () => { transactions.push('end'); },
  };
  return { host, transactions };
}

// --- Tool registry --------------------------------------------------------

describe('CAD_TOOLS registry', () => {
  it('exports the v1 set with stable names', () => {
    // 20 v1 tools across four groups:
    //   - 1 meta (cad_help)
    //   - 6 generic (get_document, query_features, get_diagnostics,
    //     dispatch_command, begin_transaction, end_transaction)
    //   - 16 modeling (sketch_create + sketch_draw_line/rect/circle/slot/arc +
    //     feature_extrude/fillet/chamfer/hole/revolve/mirror/pattern/shell/
    //     sweep/loft)
    //   - 4 id-discovery (list_bodies, list_faces, list_edges, list_sketch_regions)
    //   - 2 semantic discovery helpers (find_edges, find_face)
    //   - 4 viewport (view_fit_all, view_set_standard, view_zoom,
    //     view_screenshot)
    //   - 1 worker-sync (wait_for_rebuild — defeats the
    //     dispatch→get_diagnostics timing race)
    // view_get_state was removed: ~60 tokens/request to advertise a
    // tool with no concrete use case. See `./tools.ts` for the note.
    // Modeling + id-discovery tools wrap underlying CadCommands /
    // ToolHost methods with full JSON schemas + return new ids
    // directly so the caller never has to read source. cad_help returns
    // the canonical workflow guide. See ./modelingTools.ts +
    // ./cadHelp.ts.
    expect(CAD_TOOLS.map((t) => t.name).sort()).toEqual([
      'begin_transaction',
      'cad_help',
      'dispatch_command',
      'end_transaction',
      'feature_chamfer',
      'feature_extrude',
      'feature_fillet',
      'feature_hole',
      'feature_loft',
      'feature_mirror',
      'feature_pattern',
      'feature_revolve',
      'feature_shell',
      'feature_sweep',
      'find_edges',
      'find_face',
      'get_diagnostics',
      'get_document',
      'list_bodies',
      'list_edges',
      'list_faces',
      'list_sketch_elements',
      'list_sketch_regions',
      'query_features',
      'sketch_apply_constraint',
      'sketch_create',
      'sketch_draw_arc',
      'sketch_draw_arc3point',
      'sketch_draw_circle',
      'sketch_draw_ellipse',
      'sketch_draw_line',
      'sketch_draw_point',
      'sketch_draw_polygon',
      'sketch_draw_rectangle',
      'sketch_draw_slot',
      'sketch_draw_spline',
      'sketch_extend',
      'sketch_fillet',
      'sketch_mirror',
      'sketch_move_point',
      'sketch_move_points',
      'sketch_offset',
      'sketch_pick_geometry',
      'sketch_remove_constraint',
      'sketch_trim',
      'view_fit_all',
      'view_screenshot',
      'view_set_standard',
      'view_zoom',
      'wait_for_rebuild',
    ]);
  });

  it('every tool has a non-empty description and object inputSchema', () => {
    for (const t of CAD_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('isToolName narrows correctly', () => {
    expect(isToolName('get_document')).toBe(true);
    expect(isToolName('dispatch_command')).toBe(true);
    expect(isToolName('not_a_tool')).toBe(false);
  });

  it('findTool resolves known names + returns undefined for unknown', () => {
    expect(findTool('get_document')?.name).toBe('get_document');
    expect(findTool('made_up')).toBeUndefined();
  });
});

// --- executeTool: unknown ------------------------------------------------

describe('executeTool — unknown tool', () => {
  it('returns UNKNOWN_TOOL instead of throwing', async () => {
    const { host } = makeFakeHost();
    const r = await executeTool('totally_made_up', {}, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNKNOWN_TOOL');
    expect(r.error.message).toMatch(/totally_made_up/);
  });
});

// --- get_document --------------------------------------------------------

describe('get_document', () => {
  it('returns the host document snapshot', async () => {
    const proj = newProjectWithPart('My Project');
    const { host } = makeFakeHost({ doc: proj });
    const r = await executeTool('get_document', {}, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as CadProject).metadata.name).toBe('My Project');
  });

  it('ignores any input properties', async () => {
    const { host } = makeFakeHost();
    const r = await executeTool('get_document', { junk: true } as never, host);
    expect(r.ok).toBe(true);
  });
});

// --- dispatch_command ----------------------------------------------------

describe('dispatch_command', () => {
  it('forwards a well-formed command to host.dispatchCommand', async () => {
    const captured: { value: unknown } = { value: null };
    const { host } = makeFakeHost({
      dispatch: async (cmd) => { captured.value = cmd; return { applied: true }; },
    });
    const r = await executeTool(
      'dispatch_command',
      { command: { type: 'CreatePart', name: 'Bracket' } },
      host,
    );
    expect(r.ok).toBe(true);
    expect((captured.value as { type?: string })?.type).toBe('CreatePart');
  });

  it('returns the host result in value', async () => {
    const { host } = makeFakeHost({
      dispatch: async () => ({ applied: true, foo: 'bar' }),
    });
    const r = await executeTool(
      'dispatch_command',
      { command: { type: 'CreatePart', name: 'X' } },
      host,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { applied: boolean }).applied).toBe(true);
  });

  it('surfaces host errors as HOST_ERROR with the message', async () => {
    const { host } = makeFakeHost({
      dispatch: async () => { throw new Error('INVALID_NAME: already exists'); },
    });
    const r = await executeTool(
      'dispatch_command',
      { command: { type: 'CreatePart', name: 'X' } },
      host,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('HOST_ERROR');
    expect(r.error.message).toContain('INVALID_NAME');
  });

  it('rejects malformed input (missing command)', async () => {
    const { host } = makeFakeHost();
    const r = await executeTool('dispatch_command', {} as never, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('rejects malformed input (command without type discriminator)', async () => {
    const { host } = makeFakeHost();
    const r = await executeTool('dispatch_command', { command: { foo: 'bar' } } as never, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
    expect(r.error.message).toMatch(/type.*discriminator/i);
  });

  it('does NOT implicitly open or close a transaction', async () => {
    const { host, transactions } = makeFakeHost();
    await executeTool(
      'dispatch_command',
      { command: { type: 'CreatePart', name: 'X' } },
      host,
    );
    // The caller must explicitly call begin_transaction / end_transaction
    // when it wants a multi-step undo unit. Per-call wrapping here would
    // produce N undo steps per reply.
    expect(transactions).toEqual([]);
  });
});

// --- begin_transaction / end_transaction --------------------------------

describe('transaction tools', () => {
  it('begin_transaction routes a labeled begin to the host', async () => {
    const { host, transactions } = makeFakeHost();
    const r = await executeTool('begin_transaction', { label: 'AI: add fillet' }, host);
    expect(r.ok).toBe(true);
    expect(transactions).toEqual(['begin:AI: add fillet']);
  });

  it('begin_transaction rejects an empty or missing label', async () => {
    const { host } = makeFakeHost();
    const noLabel = await executeTool('begin_transaction', {}, host);
    expect(noLabel.ok).toBe(false);
    const emptyLabel = await executeTool('begin_transaction', { label: '   ' }, host);
    expect(emptyLabel.ok).toBe(false);
  });

  it('end_transaction routes end to the host (no args)', async () => {
    const { host, transactions } = makeFakeHost();
    await executeTool('begin_transaction', { label: 'x' }, host);
    const r = await executeTool('end_transaction', {}, host);
    expect(r.ok).toBe(true);
    expect(transactions).toEqual(['begin:x', 'end']);
  });

  it('surfaces host failures as HOST_ERROR', async () => {
    const host: ToolHost = {
      getDocument: () => ({}),
      getDiagnostics: () => null,
      dispatchCommand: async () => ({}),
      beginTransaction: async () => { throw new Error('transaction already open'); },
      endTransaction: async () => {},
    };
    const r = await executeTool('begin_transaction', { label: 'x' }, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('HOST_ERROR');
    expect(r.error.message).toMatch(/already open/);
  });
});

// --- get_diagnostics ----------------------------------------------------

describe('get_diagnostics', () => {
  it('returns the host diagnostics when no partId provided', async () => {
    const { host } = makeFakeHost({
      diagnostics: { diagnostics: ['A', 'B'], featureResults: {} },
    });
    const r = await executeTool('get_diagnostics', {}, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { diagnostics: string[] }).diagnostics).toHaveLength(2);
  });

  it('passes partId through to the host', async () => {
    const spy = vi.fn(() => ({ diagnostics: [], featureResults: {} }));
    const host: ToolHost = {
      getDocument: () => ({}),
      getDiagnostics: spy,
      dispatchCommand: async () => ({}),
      beginTransaction: async () => {},
      endTransaction: async () => {},
    };
    await executeTool('get_diagnostics', { partId: 'part_x' }, host);
    expect(spy).toHaveBeenCalledWith('part_x');
  });

  it('rejects non-string partId', async () => {
    const { host } = makeFakeHost();
    const r = await executeTool('get_diagnostics', { partId: 42 } as never, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
  });
});

// --- query_features -----------------------------------------------------

describe('query_features', () => {
  it('returns a compact list of features for all parts', async () => {
    const proj = newProjectWithPart('Test');
    const pid = Object.keys(proj.parts)[0] as PartId;
    const now = '2026-01-01T00:00:00.000Z';
    proj.parts[pid]!.timeline.push({
      id: featureId('sk1'),
      type: 'sketch', name: 'My Sketch', version: 1, enabled: true, visible: true,
      dependsOn: [], inputs: {}, createdAt: now, updatedAt: now,
    });
    proj.parts[pid]!.timeline.push({
      id: featureId('ex1'),
      type: 'extrude', name: 'My Extrude', version: 1, enabled: false, visible: true,
      dependsOn: [], inputs: {}, createdAt: now, updatedAt: now,
    });
    const { host } = makeFakeHost({ doc: proj });
    const r = await executeTool('query_features', {}, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.value as { parts: Array<{ features: Array<{ type: string; enabled: boolean }> }> };
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0]!.features).toHaveLength(2);
    expect(out.parts[0]!.features[0]!.type).toBe('sketch');
    expect(out.parts[0]!.features[1]!.enabled).toBe(false);
  });

  it('scopes to a single part when partId provided', async () => {
    const proj = newProjectWithPart('Test');
    const otherPid = partId('part_other');
    proj.parts[otherPid] = {
      id: otherPid, name: 'Other',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      parameters: emptyParameterTable(), timeline: [],
      defaultPlanes: {
        XY: { type: 'defaultPlane', name: 'XY' },
        XZ: { type: 'defaultPlane', name: 'XZ' },
        YZ: { type: 'defaultPlane', name: 'YZ' },
      },
    };
    const pid = Object.keys(proj.parts).filter((p) => p !== otherPid)[0]!;
    const { host } = makeFakeHost({ doc: proj });
    const r = await executeTool('query_features', { partId: pid }, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.value as { parts: Array<{ partId: string }> };
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0]!.partId).toBe(pid);
  });

  it('returns error envelope when partId unknown', async () => {
    const { host } = makeFakeHost();
    const r = await executeTool('query_features', { partId: 'part_nonexistent' }, host);
    expect(r.ok).toBe(true); // executor succeeded; the payload carries the error
    if (!r.ok) return;
    expect((r.value as { error?: string }).error).toMatch(/not found/);
  });
});

// --- view_* (viewport tools) ---------------------------------------------

/**
 * Build a host whose view methods are all wired to spies. Returns the
 * spies so tests can assert call counts + arguments.
 */
function makeViewHost(): {
  host: ToolHost;
  spies: {
    viewFitAll: ReturnType<typeof vi.fn>;
    viewSetStandard: ReturnType<typeof vi.fn>;
    viewZoom: ReturnType<typeof vi.fn>;
  };
} {
  const { host } = makeFakeHost();
  const spies = {
    viewFitAll: vi.fn().mockResolvedValue(undefined),
    viewSetStandard: vi.fn().mockResolvedValue(undefined),
    viewZoom: vi.fn().mockResolvedValue(undefined),
  };
  host.viewFitAll = spies.viewFitAll;
  host.viewSetStandard = spies.viewSetStandard;
  host.viewZoom = spies.viewZoom;
  return { host, spies };
}

describe('view_fit_all', () => {
  it('calls host.viewFitAll', async () => {
    const { host, spies } = makeViewHost();
    const r = await executeTool('view_fit_all', {}, host);
    expect(r.ok).toBe(true);
    expect(spies.viewFitAll).toHaveBeenCalledTimes(1);
  });

  it('returns UNSUPPORTED_BY_HOST when host has no viewport', async () => {
    const { host } = makeFakeHost(); // no view methods
    const r = await executeTool('view_fit_all', {}, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNSUPPORTED_BY_HOST');
  });
});

describe('view_set_standard', () => {
  it('forwards a valid view name', async () => {
    const { host, spies } = makeViewHost();
    const r = await executeTool('view_set_standard', { view: 'top' }, host);
    expect(r.ok).toBe(true);
    expect(spies.viewSetStandard).toHaveBeenCalledWith('top');
  });

  it('rejects unknown view names', async () => {
    const { host } = makeViewHost();
    const r = await executeTool('view_set_standard', { view: 'iso' }, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
  });
});

describe('view_zoom', () => {
  it("accepts direction='in'", async () => {
    const { host, spies } = makeViewHost();
    const r = await executeTool('view_zoom', { direction: 'in' }, host);
    expect(r.ok).toBe(true);
    expect(spies.viewZoom).toHaveBeenCalledWith('in');
  });

  it("accepts direction='out'", async () => {
    const { host, spies } = makeViewHost();
    const r = await executeTool('view_zoom', { direction: 'out' }, host);
    expect(r.ok).toBe(true);
    expect(spies.viewZoom).toHaveBeenCalledWith('out');
  });

  it('rejects other directions', async () => {
    const { host } = makeViewHost();
    const r = await executeTool('view_zoom', { direction: 'sideways' }, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
  });
});

// `view_get_state` was removed from the catalog. See the note above
// `CAD_TOOLS` for reasoning. If reinstated, add a describe block here
// that asserts both the success path and UNSUPPORTED_BY_HOST.

describe('view_screenshot', () => {
  it('returns an image-tagged result the tool loop can route', async () => {
    const { host } = makeFakeHost();
    host.captureScreenshot = vi.fn().mockResolvedValue({
      kind: 'image',
      mimeType: 'image/jpeg',
      data: 'AAAAAAAAAA==',
    });
    const r = await executeTool('view_screenshot', {}, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      kind: 'image',
      mimeType: 'image/jpeg',
      data: 'AAAAAAAAAA==',
    });
  });

  it('returns UNSUPPORTED_BY_HOST when no captureScreenshot is wired', async () => {
    const { host } = makeFakeHost();
    const r = await executeTool('view_screenshot', {}, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNSUPPORTED_BY_HOST');
  });
});

describe('wait_for_rebuild', () => {
  it('calls host.waitForRebuild with the supplied timeoutMs', async () => {
    const { host } = makeFakeHost();
    host.waitForRebuild = vi.fn().mockResolvedValue({ waitedMs: 42 });
    const r = await executeTool('wait_for_rebuild', { timeoutMs: 5000 }, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ waitedMs: 42 });
    expect(host.waitForRebuild).toHaveBeenCalledWith(5000);
  });

  it('omits timeoutMs when not provided', async () => {
    const { host } = makeFakeHost();
    host.waitForRebuild = vi.fn().mockResolvedValue({ waitedMs: 0 });
    const r = await executeTool('wait_for_rebuild', {}, host);
    expect(r.ok).toBe(true);
    expect(host.waitForRebuild).toHaveBeenCalledWith(undefined);
  });

  it('rejects a non-positive timeoutMs', async () => {
    const { host } = makeFakeHost();
    host.waitForRebuild = vi.fn();
    const r = await executeTool('wait_for_rebuild', { timeoutMs: -5 }, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
    expect(host.waitForRebuild).not.toHaveBeenCalled();
  });

  it('returns UNSUPPORTED_BY_HOST when no waitForRebuild is wired', async () => {
    const { host } = makeFakeHost();
    const r = await executeTool('wait_for_rebuild', {}, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNSUPPORTED_BY_HOST');
  });

  it('surfaces host errors as HOST_ERROR (e.g. timeout from the worker)', async () => {
    const { host } = makeFakeHost();
    host.waitForRebuild = vi.fn().mockRejectedValue(new Error('wait_for_rebuild timed out after 1000 ms'));
    const r = await executeTool('wait_for_rebuild', { timeoutMs: 1000 }, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('HOST_ERROR');
    expect(r.error.message).toMatch(/timed out/);
  });
});

// --- find_edges / find_face ---------------------------------------------

// Fake topology for a unit cube: 6 faces (one per axis±), 12 edges
// (4 per axis). Just enough metadata that the filter predicates have
// something to bite into.
//
// Naming:
//   - Faces: f_top, f_bottom, f_front, f_back, f_left, f_right
//     (all carry a `stableFaceId` except f_back, which has none — we
//     use that to test `withStableIdOnly`).
//   - Edges: e_<faceA>_<faceB> oriented so faceA precedes faceB in
//     adjacentFaces. lineSegments contains [x0,y0,z0, x1,y1,z1] so
//     find_edges can compute length.
const FAKE_CUBE_TOPOLOGY = {
  bodyId: 'b1',
  faces: [
    { faceId: 'f_top', triStart: 0, triEnd: 2, stableFaceId: 'sf_top' },
    { faceId: 'f_bottom', triStart: 2, triEnd: 4, stableFaceId: 'sf_bottom' },
    { faceId: 'f_front', triStart: 4, triEnd: 6, stableFaceId: 'sf_front' },
    { faceId: 'f_back', triStart: 6, triEnd: 8 }, // intentionally no stableFaceId
    { faceId: 'f_left', triStart: 8, triEnd: 10, stableFaceId: 'sf_left' },
    { faceId: 'f_right', triStart: 10, triEnd: 12, stableFaceId: 'sf_right' },
  ],
  edges: [
    // 12 edges of a 10mm cube. We only need lineSegments for length
    // computation — the actual XYZ values don't have to be consistent
    // with a real solid as long as the lengths come out right.
    { edgeId: 'e_top_front', lineSegments: new Float32Array([0, 0, 0, 10, 0, 0]), adjacentFaces: ['f_top', 'f_front'], stableEdgeId: 'se_top_front' },
    { edgeId: 'e_top_back', lineSegments: new Float32Array([0, 10, 0, 10, 10, 0]), adjacentFaces: ['f_top', 'f_back'], stableEdgeId: 'se_top_back' },
    { edgeId: 'e_top_left', lineSegments: new Float32Array([0, 0, 0, 0, 10, 0]), adjacentFaces: ['f_top', 'f_left'], stableEdgeId: 'se_top_left' },
    { edgeId: 'e_top_right', lineSegments: new Float32Array([10, 0, 0, 10, 10, 0]), adjacentFaces: ['f_top', 'f_right'], stableEdgeId: 'se_top_right' },
    { edgeId: 'e_bot_front', lineSegments: new Float32Array([0, 0, 5, 10, 0, 5]), adjacentFaces: ['f_bottom', 'f_front'], stableEdgeId: 'se_bot_front' },
    { edgeId: 'e_bot_back', lineSegments: new Float32Array([0, 10, 5, 10, 10, 5]), adjacentFaces: ['f_bottom', 'f_back'], stableEdgeId: 'se_bot_back' },
    { edgeId: 'e_long_diag', lineSegments: new Float32Array([0, 0, 0, 100, 0, 0]), adjacentFaces: ['f_front', 'f_back'], stableEdgeId: 'se_long' },
  ],
};

describe('find_edges', () => {
  function makeTopoHost(): { host: ToolHost } {
    const { host } = makeFakeHost();
    host.getTopology = vi.fn().mockImplementation(async (bodyId: string) =>
      bodyId === 'b1' ? FAKE_CUBE_TOPOLOGY : null,
    );
    return { host };
  }

  it('returns all edges when no filter is provided', async () => {
    const { host } = makeTopoHost();
    const r = await executeTool('find_edges', { bodyId: 'b1' }, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as unknown[]).length).toBe(FAKE_CUBE_TOPOLOGY.edges.length);
  });

  it('adjacentToFaceIds — match-ANY: edges around f_top', async () => {
    const { host } = makeTopoHost();
    const r = await executeTool('find_edges', { bodyId: 'b1', adjacentToFaceIds: ['f_top'] }, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = (r.value as Array<{ edgeId: string }>).map((e) => e.edgeId);
    expect(ids.sort()).toEqual(['e_top_back', 'e_top_front', 'e_top_left', 'e_top_right']);
  });

  it('betweenFaces — exact unordered pair returns the single fillet target', async () => {
    const { host } = makeTopoHost();
    const r = await executeTool('find_edges', { bodyId: 'b1', betweenFaces: ['f_top', 'f_front'] }, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    expect((r.value as Array<{ edgeId: string }>)[0]!.edgeId).toBe('e_top_front');
  });

  it('lengthRange filters by chord length', async () => {
    const { host } = makeTopoHost();
    const r = await executeTool('find_edges', { bodyId: 'b1', lengthRange: { min: 50 } }, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    expect((r.value as Array<{ edgeId: string }>)[0]!.edgeId).toBe('e_long_diag');
  });

  it('lengthApprox matches within tolerance', async () => {
    const { host } = makeTopoHost();
    const r = await executeTool('find_edges', { bodyId: 'b1', lengthApprox: { value: 10, tolerance: 0.01 } }, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 6 of the 7 edges have length 10; only e_long_diag is 100.
    expect(r.value).toHaveLength(6);
  });

  it('multiple filters AND together', async () => {
    const { host } = makeTopoHost();
    const r = await executeTool('find_edges', {
      bodyId: 'b1',
      adjacentToFaceIds: ['f_top'],
      lengthApprox: { value: 10 },
    }, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 4 top-face edges, all 10mm long → all 4 pass.
    expect((r.value as unknown[]).length).toBe(4);
  });

  it('rejects malformed adjacentToFaceIds', async () => {
    const { host } = makeTopoHost();
    const r = await executeTool('find_edges', { bodyId: 'b1', adjacentToFaceIds: 'f_top' } as never, host);
    expect(r.ok).toBe(false);
  });

  it('returns UNSUPPORTED_BY_HOST without getTopology', async () => {
    const { host } = makeFakeHost();
    const r = await executeTool('find_edges', { bodyId: 'b1' }, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNSUPPORTED_BY_HOST');
  });
});

describe('find_face', () => {
  function makeTopoHost(): { host: ToolHost } {
    const { host } = makeFakeHost();
    host.getTopology = vi.fn().mockImplementation(async (bodyId: string) =>
      bodyId === 'b1' ? FAKE_CUBE_TOPOLOGY : null,
    );
    return { host };
  }

  it('returns all faces when no filter is provided', async () => {
    const { host } = makeTopoHost();
    const r = await executeTool('find_face', { bodyId: 'b1' }, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as unknown[]).length).toBe(FAKE_CUBE_TOPOLOGY.faces.length);
  });

  it('adjacentToEdgeIds: faces touching e_top_front are f_top and f_front', async () => {
    const { host } = makeTopoHost();
    const r = await executeTool('find_face', { bodyId: 'b1', adjacentToEdgeIds: ['e_top_front'] }, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = (r.value as Array<{ faceId: string }>).map((f) => f.faceId).sort();
    expect(ids).toEqual(['f_front', 'f_top']);
  });

  it('withStableIdOnly drops faces without a stableFaceId', async () => {
    const { host } = makeTopoHost();
    const r = await executeTool('find_face', { bodyId: 'b1', withStableIdOnly: true }, host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = (r.value as Array<{ faceId: string }>).map((f) => f.faceId);
    // f_back has no stableFaceId in the fixture → omitted.
    expect(ids).not.toContain('f_back');
    expect(ids).toHaveLength(FAKE_CUBE_TOPOLOGY.faces.length - 1);
  });

  it('returns UNSUPPORTED_BY_HOST without getTopology', async () => {
    const { host } = makeFakeHost();
    const r = await executeTool('find_face', { bodyId: 'b1' }, host);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNSUPPORTED_BY_HOST');
  });
});
