/**
 * The XML parser now lives in `@tweakcad/core` so both the FreeCAD and SVG
 * importers share one implementation. Re-exported here so this package's
 * parser modules keep their local `./xml.ts` import path.
 */

export { parseXml, findChild, findChildren, descendants } from '@tweakcad/core/src/xml.ts';
export type { XmlNode } from '@tweakcad/core/src/xml.ts';
