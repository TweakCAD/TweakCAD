/**
 * MockKernel - deterministic mock implementation for testing.
 * Returns predictable results without WASM or real geometry.
 */

import type { Result } from '@tweakcad/core/src/result.ts';
import { ok } from '@tweakcad/core/src/result.ts';
import type { Vec3, Transform3D, BoundingBox3D, MassProperties } from '@tweakcad/core/src/math.ts';
import type { DisplayMesh, TopologyMap } from '@tweakcad/core/src/document/schema.ts';
import { bodyId, faceId, edgeId } from '@tweakcad/core/src/ids.ts';
import type { StableFaceId, StableEdgeId } from '@tweakcad/core/src/ids.ts';
import type { RepairHint } from '@tweakcad/core/src/document/schema.ts';
import type { CadKernel } from './interface.ts';
import type {
  KernelBody,
  KernelFace,
  KernelEdge,
  ResolvedProfile,
  ResolvedPlane,
  ResolvedAxis,
  CylinderSpec,
  ConeSpec,
  BoxSpec,
  SphereSpec,
  TorusSpec,
  TessellationOptions,
  StlExportOptions,
  KernelError,
} from './types.ts';

/**
 * A proper unit cube mesh with all 6 faces (24 vertices for correct normals).
 * Scaled to 25x15x10 to look like a small CAD body.
 */
function createUnitCubeMesh(): DisplayMesh {
  const sx = 25, sy = 15, sz = 10;
  // 6 faces x 4 vertices = 24 vertices (flat shading requires separate normals per face)
  const positions = new Float32Array([
    // Front face (z+)
    -sx, -sy, sz,  sx, -sy, sz,  sx, sy, sz,  -sx, sy, sz,
    // Back face (z-)
    sx, -sy, -sz,  -sx, -sy, -sz,  -sx, sy, -sz,  sx, sy, -sz,
    // Top face (y+)
    -sx, sy, sz,  sx, sy, sz,  sx, sy, -sz,  -sx, sy, -sz,
    // Bottom face (y-)
    -sx, -sy, -sz,  sx, -sy, -sz,  sx, -sy, sz,  -sx, -sy, sz,
    // Right face (x+)
    sx, -sy, sz,  sx, -sy, -sz,  sx, sy, -sz,  sx, sy, sz,
    // Left face (x-)
    -sx, -sy, -sz,  -sx, -sy, sz,  -sx, sy, sz,  -sx, sy, -sz,
  ]);

  const normals = new Float32Array([
    // Front
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
    // Back
    0, 0, -1,  0, 0, -1,  0, 0, -1,  0, 0, -1,
    // Top
    0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
    // Bottom
    0, -1, 0,  0, -1, 0,  0, -1, 0,  0, -1, 0,
    // Right
    1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
    // Left
    -1, 0, 0,  -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
  ]);

  const indices = new Uint32Array([
    0, 1, 2,  0, 2, 3,     // Front
    4, 5, 6,  4, 6, 7,     // Back
    8, 9, 10,  8, 10, 11,  // Top
    12, 13, 14,  12, 14, 15, // Bottom
    16, 17, 18,  16, 18, 19, // Right
    20, 21, 22,  20, 22, 23, // Left
  ]);

  return {
    bodyId: bodyId('mock_body'),
    positions,
    normals,
    indices,
  };
}

export class MockKernel implements CadKernel {
  private nextId = 0;
  /** Handles returned by `booleanCut`; they report less volume than a fresh body. */
  private readonly cutResults = new Set<string>();

  /** @returns A new unique mock handle ID */
  private nextHandle(): string {
    return `mock_${this.nextId++}`;
  }

  async init(): Promise<void> {
    // No initialization needed
  }

  async createSketchFace(_profile: ResolvedProfile): Promise<Result<KernelFace, KernelError>> {
    return ok({ handle: this.nextHandle(), bodyHandle: '' });
  }

  async extrudeFace(_face: KernelFace, _vector: Vec3, _origin?: string): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async revolve(
    _face: KernelFace,
    _axis: ResolvedAxis,
    _angleRad: number,
    _copy?: boolean,
    _origin?: string,
  ): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async loft(
    _faces: KernelFace[],
    _options?: { ruled?: boolean; closed?: boolean },
    _origin?: string,
  ): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async makeCylinder(_spec: CylinderSpec, _origin?: string): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async makeCone(_spec: ConeSpec, _origin?: string): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async makeBox(_spec: BoxSpec, _origin?: string): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async makeSphere(_spec: SphereSpec, _origin?: string): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async makeTorus(_spec: TorusSpec, _origin?: string): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async booleanFuse(_targets: KernelBody[]): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async booleanCut(_target: KernelBody, _tools: KernelBody[]): Promise<Result<KernelBody, KernelError>> {
    const handle = this.nextHandle();
    this.cutResults.add(handle);
    return ok({ handle, source: 'mock' });
  }

  async booleanIntersect(_targets: KernelBody[]): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async decomposeBody(body: KernelBody, _origin: string): Promise<KernelBody[]> {
    return [body];
  }

  async fillet(
    _body: KernelBody,
    _edges: KernelEdge[],
    _radius: number,
  ): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async chamfer(
    _body: KernelBody,
    _edges: KernelEdge[],
    _distance: number,
  ): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async mirror(_body: KernelBody, _plane: ResolvedPlane): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async transform(_body: KernelBody, _transform: Transform3D): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async shell(
    _body: KernelBody,
    _facesToRemove: KernelFace[],
    _thickness: number,
    _tolerance?: number,
  ): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async sweep(
    _profileFace: KernelFace,
    _pathFace: KernelFace,
    _origin?: string,
  ): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async linearPattern(
    _body: KernelBody,
    _dir: Vec3,
    _count: number,
    _spacing: number,
  ): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async circularPattern(
    _body: KernelBody,
    _axis: ResolvedAxis,
    _count: number,
  ): Promise<Result<KernelBody, KernelError>> {
    return ok({ handle: this.nextHandle(), source: 'mock' });
  }

  async getTopology(_body: KernelBody): Promise<TopologyMap> {
    return {
      bodyId: bodyId('mock_body'),
      faces: [
        { faceId: faceId('face_0'), triStart: 0, triEnd: 2, semanticRef: 'front' },
        { faceId: faceId('face_1'), triStart: 2, triEnd: 4, semanticRef: 'back' },
      ],
      edges: [
        {
          edgeId: edgeId('edge_0'),
          lineSegments: new Float32Array([0, 0, 0, 1, 0, 0]),
          adjacentFaces: [faceId('face_0'), faceId('face_1')],
        },
      ],
    };
  }

  async getBoundingBox(_body: KernelBody): Promise<BoundingBox3D> {
    return {
      min: [-0.5, -0.5, -0.5],
      max: [0.5, 0.5, 0.5],
    };
  }

  /** Every mock body touches every other, so join and cut reach them all. */
  async distanceBetween(_a: KernelBody, _b: KernelBody): Promise<number> {
    return 0;
  }

  async getMassProperties(body: KernelBody): Promise<MassProperties> {
    return {
      volume: this.cutResults.has(String(body.handle)) ? 0.5 : 1.0,
      surfaceArea: 6.0,
      centerOfMass: [0, 0, 0],
    };
  }

  async getEdgeLength(_edge: KernelEdge): Promise<number> {
    return 10;
  }

  async getFaceArea(_face: KernelFace): Promise<number> {
    return 100;
  }

  async resolveFaceRef(
    _body: KernelBody,
    _stableFaceId: StableFaceId,
    _repairHint?: RepairHint,
  ): Promise<KernelFace | null> {
    // MockKernel doesn't track topology evolution; resolution always misses.
    return null;
  }

  async resolveEdgeRef(
    _body: KernelBody,
    _stableEdgeId: StableEdgeId,
    _repairHint?: RepairHint,
  ): Promise<KernelEdge | null> {
    return null;
  }

  async getFacePlane(_face: KernelFace) {
    // Mock: return a default XY-aligned plane at the origin so tests
    // that don't care about face geometry still get a sensible value.
    return {
      origin: [0, 0, 0] as [number, number, number],
      uAxis: [1, 0, 0] as [number, number, number],
      vAxis: [0, 1, 0] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
    };
  }

  async tessellate(_body: KernelBody, _options: TessellationOptions): Promise<DisplayMesh> {
    return createUnitCubeMesh();
  }

  async exportStep(_bodies: KernelBody[]): Promise<Blob> {
    return new Blob(['MOCK STEP DATA'], { type: 'application/step' });
  }

  async exportStl(_bodies: KernelBody[], _options?: StlExportOptions): Promise<Blob> {
    return new Blob(['MOCK STL DATA'], { type: 'application/sla' });
  }

  async exportBrep(_bodies: KernelBody[]): Promise<Blob> {
    return new Blob(['MOCK BREP DATA'], { type: 'model/brep' });
  }

  async importStep(_data: ArrayBuffer, _origin?: string): Promise<Result<KernelBody[], KernelError>> {
    // Mock returns a single placeholder body so worker tests have
    // something to put in context.bodies. Real OCCT decomposes via
    // getSubShapes per solid; we don't need that fidelity in tests.
    return ok([{ handle: this.nextHandle(), source: 'mock' }]);
  }

  async importStl(_data: ArrayBuffer, _origin?: string): Promise<Result<KernelBody[], KernelError>> {
    return ok([{ handle: this.nextHandle(), source: 'mock' }]);
  }

  async importBrep(_data: ArrayBuffer, _origin?: string): Promise<Result<KernelBody[], KernelError>> {
    return ok([{ handle: this.nextHandle(), source: 'mock' }]);
  }

  async export3MF(_bodies: KernelBody[]): Promise<Blob> {
    return new Blob(['MOCK 3MF DATA'], {
      type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
    });
  }

  dispose(_handle: KernelBody | KernelFace | KernelEdge): void {
    // No-op for mock
  }
}
