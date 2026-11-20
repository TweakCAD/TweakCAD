/**
 * Deleting a part or an assembly, by the browser's rules: nothing that uses
 * it is changed silently. Instances that place it go only when the call
 * says so; anything else that uses it refuses the delete.
 */
import type { Json } from '@tweakcad/editor';
import { confirmMessage, deleteItem, deletePlan } from '../app/deletion';
import { optBool, type Args } from './common';
import { ToolError, checkCanEdit, invalid, type AiContext } from './context';

export async function partDelete(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const given = [args.part, args.assembly].filter((v) => v !== undefined);
  if (given.length !== 1 || typeof given[0] !== 'string') throw invalid('Give one of `part` or `assembly`');
  const id = given[0];
  if (args.part !== undefined && !id.startsWith('part_')) throw invalid('`part` is a part id (part_…)');
  if (args.assembly !== undefined && !id.startsWith('asm_')) throw invalid('`assembly` is an assembly id (asm_…)');
  const plan = deletePlan(ctx.services.editor.document, id);
  if (plan.kind === 'blocked')
    throw new ToolError(plan.message.startsWith('There is no') ? 'NOT_FOUND' : 'REFUSED', plan.message);
  const instances = plan.kind === 'confirm' ? plan.instances : [];
  if (instances.length > 0 && optBool(args, 'withInstances') !== true) {
    const name = plan.label.replace(/^Delete /, '');
    throw new ToolError('REFUSED', `${confirmMessage(name, instances)} Pass withInstances: true to delete them too.`);
  }
  const done = await deleteItem(ctx.services, id, () => Promise.resolve(true));
  if (!done.ok) throw new ToolError('REFUSED', done.message);
  return {
    deleted: id,
    removedInstances: instances.map((u) => ({ assembly: u.assembly, instance: u.instance, label: u.label })),
  };
}
