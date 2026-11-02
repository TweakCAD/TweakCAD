import type { CadProject, ConstructionPlaneDisplay } from '@tweakcad/core/src/document/schema.ts';

/**
 * The rebuild's construction-plane list with each plane's `visible` taken from
 * the live document.
 *
 * `SetFeatureVisibility` is display-only and does not start a rebuild, so the
 * list the last rebuild produced still carries the old flag. Reading it from
 * the document makes the eye toggle take effect at once. Returns `planes`
 * itself when every flag already matches, so callers keyed on identity don't
 * re-render for edits that leave visibility alone.
 */
export function withDocumentVisibility(
  planes: ConstructionPlaneDisplay[],
  project: CadProject,
): ConstructionPlaneDisplay[] {
  const visibleById = new Map<string, boolean>();
  for (const part of Object.values(project.parts)) {
    for (const feature of part.timeline) {
      if (feature.type === 'constructionPlane') visibleById.set(feature.id, feature.visible);
    }
  }
  let changed = false;
  const out = planes.map((plane) => {
    const visible = visibleById.get(plane.featureId);
    if (visible === undefined || visible === plane.visible) return plane;
    changed = true;
    return { ...plane, visible };
  });
  return changed ? out : planes;
}
