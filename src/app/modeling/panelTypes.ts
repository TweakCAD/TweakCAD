/** The feature panel (its `PanelRequest.kind`) that edits each feature type. */
export const PANEL_OF_TYPE: Readonly<Record<string, string>> = {
  'core.extrude': 'extrude',
  'core.revolve': 'revolve',
  'core.loft': 'loft',
  'core.sweep': 'sweep',
  'core.fillet': 'fillet',
  'core.chamfer': 'chamfer',
  'core.hole': 'hole',
  'core.thread': 'thread',
  'core.shell': 'shell',
  'core.pattern': 'pattern',
  'core.mirror': 'mirror',
  'core.move': 'move',
  'core.boolean': 'combine',
  'core.removeBody': 'removeBody',
  'core.primitive': 'primitive',
  'core.constructionPlane': 'construction.plane',
  'core.constructionAxis': 'construction.axis',
  'core.constructionPoint': 'construction.point',
  'core.constructionFrame': 'construction.frame',
  'core.measure': 'measureValues',
  'core.derive': 'derive',
  'core.asm.pattern': 'assembly.pattern',
  'core.asm.mirror': 'assembly.mirror',
  'core.asm.replicate': 'assembly.replicate',
};

/** Panels that edit nothing until OK, or edit as they go: undo and redo stay available while they are open. */
export const FREE_PANELS: ReadonlySet<string> = new Set(['sketchPlane', 'measure', 'measureValues', 'assembly.move']);

/** Whether a feature of `type` opens in a panel. */
export function editableInPanel(type: string): boolean {
  return type in PANEL_OF_TYPE;
}
