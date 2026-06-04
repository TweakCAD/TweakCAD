/**
 * Unit system definitions and conversion utilities.
 */

/** Supported unit systems */
export type UnitSystem = 'mm' | 'inch';

/** Supported parameter units */
export type ParameterUnit = 'mm' | 'deg' | 'count' | 'none';

/** Conversion factor from inches to millimeters */
const MM_PER_INCH = 25.4;

/**
 * Convert a value from one unit system to another.
 * @param value - The numeric value to convert
 * @param from - Source unit system
 * @param to - Target unit system
 * @returns Converted value
 */
export function convertLength(value: number, from: UnitSystem, to: UnitSystem): number {
  if (from === to) return value;
  if (from === 'inch' && to === 'mm') return value * MM_PER_INCH;
  if (from === 'mm' && to === 'inch') return value / MM_PER_INCH;
  return value;
}

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
