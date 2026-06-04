/**
 * Public entry point for the CAD tool catalogue.
 * Re-export only — do NOT add logic here.
 *
 * This is the pure, dependency-free *schema* surface (what tools exist and
 * their input shapes). Tool *execution* (modelingTools/toolExecutor) stays in
 * the CAD app's core — it's coupled to the document model and runs in the
 * browser.
 */
export type { CadToolDefinition, ToolInputSchema } from './tools.ts';
export { CAD_TOOLS, findTool, isToolName } from './tools.ts';
