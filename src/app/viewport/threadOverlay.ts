/**
 * A cosmetic thread drawn over the faces it threads: a helix of the
 * thread's pitch and hand, shaded on those faces' own triangles, so it
 * shows from any angle wherever the faces show and nowhere else. Where the
 * turns crowd closer than a few pixels they blend into an even tint rather
 * than flicker. It is not pickable: a click goes to the face under it.
 */
import * as THREE from 'three';
import type { BodyMesh, Key, ThreadDisplay } from '@tweakcad/worker/src/v2/service/types';
import { ORDER } from './style';

export const THREAD_COLOR = 0x1f2937;
export const THREAD_OPACITY = 0.6;

/** Half a line's width, in turns of the thread. */
const HALF_WIDTH = 0.09;

const VERTEX = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
varying vec3 vLocal;
void main() {
  vLocal = position;
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec3 color;
uniform float opacity;
uniform vec3 start;
uniform vec3 axis;
uniform vec3 across;
uniform vec3 around;
uniform float pitch;
uniform float runLength;
uniform float radius;
uniform float halfWidth;
varying vec3 vLocal;
void main() {
  #include <clipping_planes_fragment>
  vec3 d = vLocal - start;
  float t = dot(d, axis);
  if (t < 0.0 || t > runLength) discard;
  vec2 q = vec2(dot(d, across), dot(d, around));
  if (abs(length(q) - radius) > 0.05 * radius + 0.01) discard;
  float turns = t / pitch;
  float phase = turns - atan(q.y, q.x) / PI2;
  // The same phase with its seam on the other side, for a width that does not jump at the seam.
  float other = turns - atan(-q.y, -q.x) / PI2;
  float w = max(min(fwidth(phase), fwidth(other)), 1e-5);
  float f = fract(phase);
  float dist = min(f, 1.0 - f);
  float line = 1.0 - smoothstep(halfWidth - w, halfWidth + w, dist);
  float crowd = smoothstep(0.15, 0.5, w);
  float alpha = mix(line, 2.0 * halfWidth, crowd) * opacity;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

/** Two unit vectors square to `axis` and to each other, with `across × around = axis`. */
function basis(axis: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const helper = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const across = helper.sub(axis.clone().multiplyScalar(helper.dot(axis))).normalize();
  const around = axis.clone().cross(across).normalize();
  return [across, around];
}

/**
 * The overlay of `thread` on the triangles of `mesh` that belong to its
 * faces and that `shows` lets through, in the mesh's coordinates; null when
 * none of its faces is in the mesh.
 */
export function threadOverlay(
  mesh: BodyMesh,
  thread: ThreadDisplay,
  shows: (face: Key) => boolean = () => true,
): THREE.Mesh | null {
  const faces = new Set(thread.faces.filter(shows));
  const used = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i + 2 < mesh.faces.length; i += 3) {
    if (!faces.has(mesh.faces[i + 2] as number)) continue;
    const first = mesh.faces[i] as number;
    const count = mesh.faces[i + 1] as number;
    for (let t = first; t < first + count; t++) {
      for (let c = 0; c < 3; c++) {
        const v = mesh.indices[3 * t + c] as number;
        let at = used.get(v);
        if (at === undefined) {
          at = used.size;
          used.set(v, at);
          positions.push(
            mesh.positions[3 * v] as number,
            mesh.positions[3 * v + 1] as number,
            mesh.positions[3 * v + 2] as number,
          );
        }
        indices.push(at);
      }
    }
  }
  if (indices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

  const axis = new THREE.Vector3(...thread.direction).normalize();
  const [across, right] = basis(axis);
  // A left-handed helix turns the other way round the axis as it climbs.
  const around = thread.hand === 'left' ? right.clone().negate() : right;
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      color: { value: new THREE.Color(THREAD_COLOR) },
      opacity: { value: THREAD_OPACITY },
      start: { value: new THREE.Vector3(...thread.start) },
      axis: { value: axis },
      across: { value: across },
      around: { value: around },
      pitch: { value: thread.pitch },
      runLength: { value: thread.length },
      radius: { value: thread.radius },
      halfWidth: { value: HALF_WIDTH },
    },
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    clipping: true,
  });
  const overlay = new THREE.Mesh(geometry, material);
  overlay.name = `thread ${thread.designation}`;
  overlay.renderOrder = ORDER.thread;
  overlay.raycast = () => undefined;
  overlay.userData.thread = thread;
  return overlay;
}

/** How a thread overlay shows: `opacity` scales its lines (a see-through or ghosted body), `clipping` cuts it with a section. */
export function setThreadLook(overlay: THREE.Mesh, opacity: number, clipping: THREE.Plane[] | null): void {
  const material = overlay.material as THREE.ShaderMaterial;
  (material.uniforms.opacity as THREE.IUniform<number>).value = THREAD_OPACITY * opacity;
  if (material.clippingPlanes !== clipping) {
    material.clippingPlanes = clipping;
    material.needsUpdate = true;
  }
}
