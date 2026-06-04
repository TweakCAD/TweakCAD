/**
 * Parse a FreeCAD Document.xml string into typed FcDocument structures.
 *
 * Walks the parsed XML tree and dispatches per-object-type parsing into
 * geometryParser / featureParser. The result is a flat lookup of objects
 * keyed by name plus an ordered list mirroring <Objects>.
 */

import type { Result } from '@tweakcad/core/src/result.ts';
import { ok, err } from '@tweakcad/core/src/result.ts';
import type {
  FcDocument,
  FcObject,
  FcObjectHeader,
  FcConstraint,
  FcSketchObject,
  FcPadObject,
  FcPocketObject,
  FcBodyObject,
  FcGenericObject,
} from '../types/fcstdTypes.ts';
import { parseXml, findChild, findChildren } from './xml.ts';
import type { XmlNode } from './xml.ts';
import { parseGeometryList } from './geometryParser.ts';
import {
  readObjectProperties,
  parseExtrudeProperties,
  parseBodyProperties,
  parseSketchSupport,
} from './featureParser.ts';

/**
 * Parse a Document.xml string.
 *
 * @param xmlText - The raw XML content
 * @returns A typed FcDocument, or an error message
 */
export function parseDocumentXml(xmlText: string): Result<FcDocument, string> {
  const xml = parseXml(xmlText);
  if (!xml.ok) return err(`Document.xml: ${xml.error}`);
  const docElem = xml.value;
  if (docElem.name !== 'Document') {
    return err(`Document.xml root is <${docElem.name}>, expected <Document>`);
  }

  const headers = parseObjectsList(docElem);
  const objects = parseObjectData(docElem, headers);

  return ok({
    schemaVersion: docElem.attrs['SchemaVersion'],
    programVersion: docElem.attrs['ProgramVersion'],
    fileVersion: docElem.attrs['FileVersion'],
    objectsOrder: headers,
    objects,
  });
}

function parseObjectsList(docElem: XmlNode): FcObjectHeader[] {
  const objectsNode = findChild(docElem, 'Objects');
  if (!objectsNode) return [];
  const out: FcObjectHeader[] = [];
  for (const child of findChildren(objectsNode, 'Object')) {
    const type = child.attrs['type'] ?? '';
    const name = child.attrs['name'] ?? '';
    if (name.length > 0) out.push({ type, name });
  }
  return out;
}

function parseObjectData(docElem: XmlNode, headers: FcObjectHeader[]): Record<string, FcObject> {
  const dataNode = findChild(docElem, 'ObjectData');
  const typeByName = new Map<string, string>();
  for (const h of headers) typeByName.set(h.name, h.type);

  const out: Record<string, FcObject> = {};
  if (!dataNode) return out;

  for (const objNode of findChildren(dataNode, 'Object')) {
    const name = objNode.attrs['name'];
    if (!name) continue;
    const type = typeByName.get(name) ?? '';
    const propertiesNode = findChild(objNode, 'Properties');
    const props = readObjectProperties(propertiesNode);
    const label = props.scalars['Label'];

    const common = {
      name,
      type,
      label,
      properties: props.scalars,
    };

    switch (type) {
      case 'PartDesign::Body': {
        const bodyProps = parseBodyProperties(props);
        const body: FcBodyObject = {
          ...common,
          kind: 'body',
          groupLinks: bodyProps.groupLinks,
          tip: bodyProps.tip,
        };
        out[name] = body;
        break;
      }
      case 'Sketcher::SketchObject': {
        const geomList = findPropertyInner(propertiesNode, 'Geometry', 'GeometryList');
        const constraintList = findPropertyInner(propertiesNode, 'Constraints', 'ConstraintList');
        const sketch: FcSketchObject = {
          ...common,
          kind: 'sketch',
          geometry: parseGeometryList(geomList),
          constraints: parseConstraintList(constraintList),
          supportName: parseSketchSupport(propertiesNode),
        };
        out[name] = sketch;
        break;
      }
      case 'PartDesign::Pad': {
        const ext = parseExtrudeProperties(props);
        const pad: FcPadObject = {
          ...common,
          kind: 'pad',
          length: ext.length,
          reversed: ext.reversed,
          midplane: ext.midplane,
          padType: ext.type,
          profileName: ext.profileName,
        };
        out[name] = pad;
        break;
      }
      case 'PartDesign::Pocket': {
        const ext = parseExtrudeProperties(props);
        const pocket: FcPocketObject = {
          ...common,
          kind: 'pocket',
          length: ext.length,
          reversed: ext.reversed,
          midplane: ext.midplane,
          pocketType: ext.type,
          profileName: ext.profileName,
        };
        out[name] = pocket;
        break;
      }
      default: {
        const generic: FcGenericObject = { ...common, kind: 'generic' };
        out[name] = generic;
        break;
      }
    }
  }
  return out;
}

function findPropertyInner(
  propertiesNode: XmlNode | undefined,
  propertyName: string,
  innerName: string,
): XmlNode | undefined {
  if (!propertiesNode) return undefined;
  for (const prop of findChildren(propertiesNode, 'Property')) {
    if (prop.attrs['name'] !== propertyName) continue;
    return findChild(prop, innerName);
  }
  return undefined;
}

function parseConstraintList(constraintListNode: XmlNode | undefined): FcConstraint[] {
  if (!constraintListNode) return [];
  const out: FcConstraint[] = [];
  for (const c of findChildren(constraintListNode, 'Constrain')) {
    out.push({
      type: toInt(c.attrs['Type'], 0),
      name: c.attrs['Name'] && c.attrs['Name'].length > 0 ? c.attrs['Name'] : undefined,
      value: toFloat(c.attrs['Value'], 0),
      first: toInt(c.attrs['First'], -2000),
      firstPos: toInt(c.attrs['FirstPos'], 0),
      second: toInt(c.attrs['Second'], -2000),
      secondPos: toInt(c.attrs['SecondPos'], 0),
      third: toInt(c.attrs['Third'], -2000),
      thirdPos: toInt(c.attrs['ThirdPos'], 0),
    });
  }
  return out;
}

function toInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : fallback;
}

function toFloat(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}
