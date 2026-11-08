/** Registries and closed lists the core reader checks against (spec chapters 2, 6, 9, 11). */

export const FORMAT = 'tweakcad.document';
export const SCHEMA_VERSION = 2;
/** Newest naming-rules version this reader computes. */
export const NAMING_RULES = 1;
/** Expression grammar versions this reader evaluates. */
export const GRAMMARS: readonly number[] = [1];

/** Value-type registry (6.2). */
export const VALUE_TYPES = [
  'number',
  'integer',
  'boolean',
  'text',
  'choice',
  'vector',
  'placement',
  'date',
  'library',
] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

/** Value types that carry a quantity (6.2). */
export const QUANTITY_TYPES: readonly string[] = ['number', 'vector'];

/** Quantity registry (2.6). */
export const QUANTITIES = [
  'length',
  'angle',
  'area',
  'volume',
  'mass',
  'density',
  'force',
  'torque',
  'pressure',
  'time',
  'ratio',
  'lead',
] as const;

/** Configuration input types (7.4). */
export const CONFIGURATION_INPUT_TYPES: readonly string[] = ['choice', 'boolean', 'integer'];

/** Measure kinds of a `measure` value (6.3). */
export const MEASURE_KINDS: readonly string[] = ['distance', 'length', 'area', 'volume', 'angle', 'radius'];

/** `standard` and `sketchStandard` reference names (9.1). */
export const STANDARD_NAMES: readonly string[] = ['xy', 'xz', 'yz', 'origin', 'x', 'y', 'z'];
export const SKETCH_STANDARD_NAMES: readonly string[] = ['origin', 'x', 'y'];

/** Library entry kinds (11). */
export const LIBRARY_KINDS: readonly string[] = [
  'document',
  'material',
  'appearance',
  'threadStandard',
  'sheetMetalRules',
  'profileStandard',
  'font',
];

/** Grammar-1 reserved words: never names in `refs` (appendix B). */
export { RESERVED_WORDS } from '../expr';

/** Parameter and value names (6.2). */
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
