/**
 * Branded ID types for compile-time safety.
 * Passing a PartId where a FeatureId is expected is a compile error.
 */

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Unique identifier for a project */
export type ProjectId = Brand<string, 'ProjectId'>;

/** Unique identifier for a part within a project */
export type PartId = Brand<string, 'PartId'>;

/** Unique identifier for a feature within a part timeline */
export type FeatureId = Brand<string, 'FeatureId'>;

/** Unique identifier for a body (solid shape) */
export type BodyId = Brand<string, 'BodyId'>;

/** Unique identifier for a face on a body */
export type FaceId = Brand<string, 'FaceId'>;

/** Unique identifier for an edge on a body */
export type EdgeId = Brand<string, 'EdgeId'>;

/**
 * Stable identifier for a face that survives rebuilds. Distinct from
 * {@link FaceId} which is regenerated on every rebuild (and is what the
 * viewport uses for picking). Stable IDs are assigned by the topology-naming
 * layer when a face first enters the system, and propagated through
 * `EvolutionData` mappings across boolean/fillet/mirror/etc. ops.
 */
export type StableFaceId = Brand<string, 'StableFaceId'>;

/**
 * Stable identifier for an edge that survives rebuilds. Same semantics as
 * {@link StableFaceId} but for edges (one-dimensional shape sub-elements).
 * Unlocks Fillet/Chamfer's edge-selection persistence.
 */
export type StableEdgeId = Brand<string, 'StableEdgeId'>;

/** Unique identifier for a sketch entity */
export type EntityId = Brand<string, 'EntityId'>;

/** Unique identifier for a reference asset */
export type ReferenceId = Brand<string, 'ReferenceId'>;

/** Unique identifier for an assembly */
export type AssemblyId = Brand<string, 'AssemblyId'>;

/**
 * Unique identifier for one placement of a part or sub-assembly inside an
 * assembly. Distinct from `PartId`: the same part placed four times is one
 * `PartId` and four `InstanceId`s. Joints, per-instance visibility and BOM
 * quantities all key on this rather than on the part.
 */
export type InstanceId = Brand<string, 'InstanceId'>;

// --- Factory functions ---

/** @param raw - Raw string to brand as ProjectId */
export function projectId(raw: string): ProjectId {
  return raw as ProjectId;
}

/** @param raw - Raw string to brand as PartId */
export function partId(raw: string): PartId {
  return raw as PartId;
}

/** @param raw - Raw string to brand as FeatureId */
export function featureId(raw: string): FeatureId {
  return raw as FeatureId;
}

/** @param raw - Raw string to brand as BodyId */
export function bodyId(raw: string): BodyId {
  return raw as BodyId;
}

/** @param raw - Raw string to brand as FaceId */
export function faceId(raw: string): FaceId {
  return raw as FaceId;
}

/** @param raw - Raw string to brand as EdgeId */
export function edgeId(raw: string): EdgeId {
  return raw as EdgeId;
}

/** @param raw - Raw string to brand as StableFaceId */
export function stableFaceId(raw: string): StableFaceId {
  return raw as StableFaceId;
}

/** @param raw - Raw string to brand as StableEdgeId */
export function stableEdgeId(raw: string): StableEdgeId {
  return raw as StableEdgeId;
}

/** @param raw - Raw string to brand as EntityId */
export function entityId(raw: string): EntityId {
  return raw as EntityId;
}

/** @param raw - Raw string to brand as ReferenceId */
export function referenceId(raw: string): ReferenceId {
  return raw as ReferenceId;
}

/** @param raw - Raw string to brand as AssemblyId */
export function assemblyId(raw: string): AssemblyId {
  return raw as AssemblyId;
}

/** @param raw - Raw string to brand as InstanceId */
export function instanceId(raw: string): InstanceId {
  return raw as InstanceId;
}

/**
 * Generate a unique ID with a prefix.
 * @param prefix - ID prefix (e.g., 'part', 'feature', 'sketch')
 * @returns A string of format `{prefix}_{8-char-uuid}`
 */
export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}
