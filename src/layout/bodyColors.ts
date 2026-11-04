/**
 * Body colours as the viewport and browser tree read them.
 *
 * Colours live per part (`CadPart.bodyColors`), but body ids carry their
 * feature id and so are unique across parts; one map covers the document.
 */

import type { CadProject } from '@tweakcad/core/src/document/schema.ts';
import { bodyColorOf } from '@tweakcad/core/src/document/schema.ts';

/** Every well-formed body colour in the document, by body id. */
export function bodyColorMap(project: Readonly<CadProject>): Map<string, string> {
  const colors = new Map<string, string>();
  for (const part of Object.values(project.parts)) {
    for (const bodyId of Object.keys(part.bodyColors ?? {})) {
      const c = bodyColorOf(part, bodyId);
      if (c !== undefined) colors.set(bodyId, c);
    }
  }
  return colors;
}

/**
 * The swatches the body menu offers, in display order. Picked to stay
 * distinct from each other and from the selection and ghost tints.
 */
export const BODY_COLOR_SWATCHES: readonly { color: string; name: string }[] = [
  { color: '#e53935', name: 'Red' },
  { color: '#fb8c00', name: 'Orange' },
  { color: '#fdd835', name: 'Yellow' },
  { color: '#43a047', name: 'Green' },
  { color: '#00acc1', name: 'Teal' },
  { color: '#1e88e5', name: 'Blue' },
  { color: '#8e24aa', name: 'Purple' },
  { color: '#d81b60', name: 'Pink' },
  { color: '#6d4c41', name: 'Brown' },
  { color: '#757575', name: 'Grey' },
  { color: '#212121', name: 'Black' },
  { color: '#fafafa', name: 'White' },
];
