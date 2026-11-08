/**
 * Object colours from FreeCAD's `GuiDocument.xml`: one material list per
 * object since 1.0 (its first entry is the object's colour while no face has
 * its own), a packed colour and a transparency before that.
 */
import { findChild, findChildren, parseXml, type XmlNode } from './xml';

export interface Appearance {
  /** `#rrggbb`. */
  color: string;
  /** 0 clear to 1 opaque. */
  opacity: number;
}

/** A packed `0xRRGGBBAA` colour as `#rrggbb`. */
function hex(packed: number): string {
  return `#${(packed >>> 8).toString(16).padStart(6, '0')}`;
}

/** The first entry of a material list file: four packed colours, shininess and transparency. */
function firstMaterial(bytes: Uint8Array): Appearance | undefined {
  if (bytes.length < 28) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) < 1) return undefined;
  return { color: hex(view.getUint32(8, true)), opacity: 1 - view.getFloat32(24, true) };
}

function property(vp: XmlNode, name: string): XmlNode | undefined {
  const bag = findChild(vp, 'Properties');
  return bag ? findChildren(bag, 'Property').find((p) => p.attrs.name === name) : undefined;
}

/** Each object's colour by its name, where its view provider holds one. */
export function readAppearances(files: ReadonlyMap<string, Uint8Array>): Map<string, Appearance> {
  const out = new Map<string, Appearance>();
  const gui = files.get('GuiDocument.xml');
  if (!gui) return out;
  const xml = parseXml(new TextDecoder().decode(gui));
  if (!xml.ok) return out;
  const data = findChild(xml.value, 'ViewProviderData');
  for (const vp of data ? findChildren(data, 'ViewProvider') : []) {
    const name = vp.attrs.name;
    if (!name) continue;
    const list = property(vp, 'ShapeAppearance')?.children[0]?.attrs.file;
    const bytes = list ? files.get(list) : undefined;
    const material = bytes ? firstMaterial(bytes) : undefined;
    if (material) {
      out.set(name, material);
      continue;
    }
    const packed = property(vp, 'ShapeColor')?.children[0]?.attrs.value;
    if (packed === undefined) continue;
    const transparency = Number(property(vp, 'Transparency')?.children[0]?.attrs.value ?? 0);
    out.set(name, { color: hex(Number(packed)), opacity: 1 - transparency / 100 });
  }
  return out;
}

/** FreeCAD's default greys: an object showing one has not been given a colour. */
export function isDefaultColor(color: string): boolean {
  return color === '#cccccc' || color === '#cdcdcd' || color === '#c8c8c8';
}
