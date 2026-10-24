/**
 * Parameter units and value formatting.
 *
 * **Units invariant: TweakCAD is millimetre-native. Every length stored
 * anywhere in a `.cadjson` is in millimetres, and every angle is in
 * degrees.** Importers normalise on the way in — DXF scales by `$INSUNITS`
 * (`sketch/io/dxfImport.ts`), SVG by its viewBox ratio — so no consumer ever
 * has to ask what unit a stored number is in, and the expression grammar
 * needs no unit literals.
 *
 * There is deliberately no document-level unit system and no length
 * converter. `CadProject` carried `units: 'mm' | 'inch'` until this was
 * settled, but nothing read it and nothing converted, so a file declaring
 * inches would have had every length silently taken as millimetres. If an
 * inch *readout* is ever wanted it belongs in the formatting layer, converting
 * on the way to the screen and never on the way into the document.
 *
 * {@link ParameterUnit} below is a different thing: a per-parameter tag that
 * says how to render one parameter's value, and whether it is a length, an
 * angle or a count.
 */

/** Supported parameter units */
export type ParameterUnit = 'mm' | 'deg' | 'count' | 'none';

/**
 * Format a value with its unit suffix.
 * @param value - The numeric value
 * @param unit - The unit type
 * @param precision - Decimal precision
 * @returns Formatted string
 */
export function formatWithUnit(value: number, unit: ParameterUnit, precision = 2): string {
  const formatted = value.toFixed(precision);
  switch (unit) {
    case 'mm':
      return `${formatted} mm`;
    case 'deg':
      return `${formatted}\u00B0`;
    case 'count':
      return `${Math.round(value)}`;
    case 'none':
      return formatted;
  }
}
