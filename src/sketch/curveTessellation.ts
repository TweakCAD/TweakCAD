/**
 * Shared 2D curve tessellation for sketch rendering.
 *
 * The implementations now live in `@tweakcad/core` (`lib/core/src/sketch/
 * curveSampling.ts`) so the worker's profile→wire builder can reuse the
 * exact same sampling the editor draws with. This module re-exports them
 * for the editor scene (`SketchSceneManager`) and the readonly overlay
 * (`SketchViewer`), keeping their import paths stable.
 */

export {
  sampleCubicBezier,
  catmullRomSpline,
  sampleEllipse,
} from '@tweakcad/core/src/sketch/curveSampling.ts';
