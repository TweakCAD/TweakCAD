// The slice of opentype.js the sketch Text tool uses. The package ships no
// type declarations.
declare module 'opentype.js' {
  import type { OutlineCommand } from '@tweakcad/core/src/sketch/text/textOutline.ts';

  export interface Path {
    commands: OutlineCommand[];
  }

  export interface Font {
    unitsPerEm: number;
    tables: { os2?: { sCapHeight?: number } };
    getPath(text: string, x: number, y: number, fontSize: number, options?: { kerning?: boolean }): Path;
  }

  export function parse(buffer: ArrayBuffer): Font;
}
