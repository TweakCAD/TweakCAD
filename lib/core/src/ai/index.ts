/**
 * Public entry point for the CAD tools surface.
 * Re-export only — do NOT add logic here.
 */

// Tool *schemas* now live in the shared @tweakcad/cad-tools package (common/).
export type { CadToolDefinition, ToolInputSchema } from '@tweakcad/cad-tools';
export { CAD_TOOLS, findTool, isToolName } from '@tweakcad/cad-tools';

export type { ToolHost, ToolExecutionError } from './toolExecutor.ts';
export { executeTool } from './toolExecutor.ts';

// NOTE: the system prompt is not part of core. The canonical CAD-tool
// prompt for MCP hosts lives in the MCP bridge project.
