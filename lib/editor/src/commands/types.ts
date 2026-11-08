import type { SolvedSketch } from '@tweakcad/format';
import type { Json } from '../rows';

/**
 * Every command the editor runs. Commands are plain JSON and address rows
 * by id, never by position, so a log of them can be replayed or ordered by a
 * server. Rows and values a command adds come whole, ids included; a command
 * that must make ids of its own (region fates) takes them from the editor's
 * generator and records them in its log entry.
 *
 * `before` places a new row before the row with that id in its table;
 * absent, at the end. `set` and `unset` edit a row's fields and keep every
 * other key and its extensions (chapter 18).
 */
export type EditorCommand =
  // Document
  | { type: 'renameDocument'; name: string }
  | { type: 'setRoot'; root: Json }
  | { type: 'setProperty'; owner: string; name: string; property?: Json }
  | AddLibraryEntry
  // Parts and assemblies
  | { type: 'addPart'; part: Json; before?: string }
  | { type: 'removePart'; part: string }
  | { type: 'renamePart'; part: string; name: string }
  | { type: 'addAssembly'; assembly: Json; before?: string }
  | { type: 'removeAssembly'; assembly: string }
  | { type: 'renameAssembly'; assembly: string; name: string }
  // Features; `names` carries the name-table entries of references the feature or inputs bring, `assets` the asset rows (13.1) a new feature uses
  | { type: 'addFeature'; container: string; feature: Json; names?: Json; assets?: Json; before?: string }
  | { type: 'removeFeature'; feature: string }
  | { type: 'moveFeature'; feature: string; container: string; before?: string }
  | { type: 'renameFeature'; feature: string; name: string }
  | { type: 'setSuppressed'; feature: string; suppressed: boolean }
  // Freezing (7.2): `frozen` is the feature's `{"frozen": …}` field as a build wrote it, with the asset rows and name-table entries it uses; absent, the feature is live again
  | { type: 'setFrozen'; feature: string; frozen?: Json; assets?: Json; names?: Json }
  | { type: 'setRollback'; part: string; before?: string }
  | { type: 'replaceInput'; feature: string; pointer: string; with?: unknown; names?: Json }
  | { type: 'writeReference'; feature: string; pointer: string; reference: Json; names: Json }
  // Feature groups of a part's timeline (7.1): a group lists features that stand next to each other in that timeline, each in one group at most
  | { type: 'addGroup'; part: string; group: Json; before?: string }
  | { type: 'editGroup'; group: string; name?: string; members?: string[] }
  | { type: 'removeGroup'; group: string }
  // Values
  | { type: 'setValueDef'; value: string; def: Json }
  | { type: 'renameValue'; value: string; name?: string }
  | { type: 'setValueFlags'; value: string; public?: boolean; published?: boolean }
  // Parameters
  | { type: 'addParameterTable'; owner: string; table: Json; before?: string }
  | { type: 'renameParameterTable'; table: string; name: string }
  | { type: 'removeParameterTable'; table: string }
  | { type: 'addParameter'; table: string; parameter: Json; before?: string }
  | { type: 'editParameter'; parameter: string; set?: Json; unset?: string[] }
  | { type: 'removeParameter'; parameter: string }
  // Configurations; a row is named by its option's literal, unique in its configuration
  | { type: 'addConfiguration'; owner: string; configuration: Json; before?: string }
  | { type: 'removeConfiguration'; configuration: string }
  | { type: 'setConfigurationInput'; configuration: string; input: string }
  | { type: 'addConfigurationRow'; configuration: string; row: Json; before?: Literal }
  | { type: 'editConfigurationRow'; configuration: string; option: Literal; set?: Json; unset?: string[] }
  | { type: 'removeConfigurationRow'; configuration: string; option: Literal }
  // Attributes, selection sets and notes; `names` carries the name-table entries of references they bring
  | { type: 'addAttribute'; owner: string; attribute: Json; names?: Json; before?: string }
  | { type: 'editAttribute'; attribute: string; target?: Json; set?: Json; unset?: string[]; names?: Json }
  | { type: 'removeAttribute'; attribute: string }
  | { type: 'addSelectionSet'; part: string; set: Json; names?: Json; before?: string }
  | { type: 'editSelectionSet'; set: string; name?: string; members?: Json[]; names?: Json }
  | { type: 'removeSelectionSet'; set: string }
  | { type: 'addNote'; owner: string; note: Json; names?: Json; before?: string }
  | { type: 'editNote'; note: string; set?: Json; unset?: string[]; names?: Json }
  | { type: 'removeNote'; note: string }
  // Assembly rows: instances, joint origins, joints, relations, rigid groups, contact sets, positions, exploded views
  | { type: 'addAssemblyRow'; assembly: string; table: AssemblyTable; row: Json; names?: Json; before?: string }
  | { type: 'editAssemblyRow'; row: string; set?: Json; unset?: string[]; names?: Json }
  | { type: 'removeAssemblyRow'; row: string }
  | { type: 'setActivePosition'; assembly: string; position?: string }
  // The library (11) and captured contexts (12.4); `assets` carries the asset rows their stored shapes use
  | { type: 'removeLibraryEntry'; entry: string }
  | { type: 'addContext'; part: string; context: Json; assets?: Json; names?: Json; before?: string }
  | { type: 'editContext'; context: string; set?: Json; unset?: string[]; assets?: Json; names?: Json; label?: string }
  | { type: 'removeContext'; context: string }
  // Sketch rows
  | EditSketch
  | { type: 'pickRegion'; sketch: string; region: Json };

export type Literal = string | boolean | number;

export type AssemblyTable =
  'instances' | 'jointOrigins' | 'joints' | 'relations' | 'rigidGroups' | 'contactSets' | 'positions' | 'explodedViews';

/**
 * Adds a library entry (chapter 11) with the asset rows (13.1) its content
 * names, by content hash, as a font for sketch text is added. An asset the
 * document already holds under that hash is kept as it is; one whose bytes do
 * not hash to its key is refused.
 */
export interface AddLibraryEntry {
  type: 'addLibraryEntry';
  entry: Json;
  assets?: Record<string, Json>;
  before?: string;
}

/** The sketch tables `editSketch` adds rows to. */
export type SketchTable = 'points' | 'curves' | 'constraints' | 'text';

/**
 * One edit of a sketch's rows, as one undo step: point merges, then
 * removals, then curves moved to `retired`, then additions, then field
 * edits. Positions and `solved` numbers are stored as given; solving is the
 * sketch editor's.
 *
 * - `merge` makes points one, as coincidence is a shared point (8.1): every
 *   row naming `from` (curves, constraints, regions and their stored uses,
 *   retired rows, text) names `into` instead, and `from` is removed. The
 *   rows that then name a point twice are the caller's to remove.
 *
 * - Removing a point or curve removes the constraints on it, and the points
 *   of a removed curve that nothing else uses.
 *   A removed curve that something still names (a curve made from it, a
 *   live or retired region, a text path) is retired with fate `deleted`
 *   instead, since those names must still find it.
 * - `retire` moves curves to `retired` with a fate: `split` for a curve that
 *   trimming or splitting replaced by pieces whose `origin` is it.
 * - `solved` is the sketch as solved after this edit (with its external
 *   curves and glyph contours). Given it, region fates (8.3) are written
 *   for the boundary curves this edit added, removed or retired, and for
 *   curves whose fields it changed other than a solver variable (`radius`,
 *   `minorRadius`), and for curves a merge puts on other points: a curve
 *   made construction or put on other points leaves or joins the boundary
 *   as a removed or added one does. Text rows added, removed or changed
 *   count by their glyph contours, a changed one as removed and added back. They come from
 *   the format's detection and matching; absent, the region table is left
 *   as it is and evaluation matches it at the next solve.
 */
export interface EditSketch {
  type: 'editSketch';
  sketch: string;
  /** The undo label; default "Edit sketch". */
  label?: string;
  merge?: { from: string; into: string }[];
  remove?: string[];
  retire?: { id: string; fate: 'split' | 'deleted' }[];
  add?: Partial<Record<SketchTable, Json[]>>;
  update?: { id: string; set?: Json; unset?: string[] }[];
  solved?: SolvedSketch;
  /** Name-table entries the rows' references use (an external curve's `source`), merged as `writeReference` merges them. */
  names?: Json;
}

export type CommandType = EditorCommand['type'];
export type CommandOf<T extends CommandType> = Extract<EditorCommand, { type: T }>;
