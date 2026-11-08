// The slice of opentype.js that sketch text reads: glyphs by character, their
// outlines in font units (y up) and the font's metrics. The package ships no
// type declarations; declarations of this module elsewhere merge with these.
declare module 'opentype.js' {
  /** One outline command, in font units. */
  export interface GlyphCommand {
    type: 'M' | 'L' | 'Q' | 'C' | 'Z';
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }

  export interface GlyphOutline {
    commands: GlyphCommand[];
  }

  /** A TrueType outline point. */
  export interface GlyphPoint {
    x: number;
    y: number;
    onCurve: boolean;
    lastPointOfContour: boolean;
  }

  export interface Glyph {
    index: number;
    advanceWidth?: number;
    /** Built on first read; a TrueType glyph's `points` are set once it is. */
    readonly path: GlyphOutline;
    points?: GlyphPoint[];
  }

  export interface Font {
    unitsPerEm: number;
    tables: { os2?: { sCapHeight?: number } };
    outlinesFormat: 'truetype' | 'cff';
    charToGlyph(c: string): Glyph;
    getKerningValue(left: Glyph, right: Glyph): number;
  }

  export function parse(buffer: ArrayBuffer): Font;
}
