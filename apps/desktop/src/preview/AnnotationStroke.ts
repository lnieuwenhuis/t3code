/**
 * Incremental geometry for one freehand stroke of the in-app browser's
 * annotation Draw tool. Lives in its own electron-free module so the math can
 * be unit-tested without spinning up an Electron preload context
 * (`PickPreload.ts` itself imports `electron` and `react-grab/primitives`,
 * which can't load under vitest).
 *
 * A stroke grows by one point per `pointermove`, so everything here is O(1) in
 * the number of points already collected: points are pushed in place instead of
 * copied, the extents widen against the new point alone, and the SVG path keeps
 * the prefix it has already built so a new segment is one concatenation. That
 * also keeps the points out of `Math.min(...)`/`Math.max(...)`, which throws
 * `RangeError` once a stroke outgrows the engine's argument limit.
 */

import type { PreviewAnnotationPoint, PreviewAnnotationRect } from "@t3tools/contracts";

export interface StrokeGeometry {
  /** Shared with the stroke target: appended in place, never reallocated. */
  readonly points: PreviewAnnotationPoint[];
  /** Running extents of every point so far, before stroke-width padding. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** The `d` attribute minus its trailing segment, which the last point owns. */
  prefix: string;
}

export function beginStroke(point: PreviewAnnotationPoint): StrokeGeometry {
  return {
    points: [point],
    minX: point.x,
    minY: point.y,
    maxX: point.x,
    maxY: point.y,
    prefix: `M ${point.x} ${point.y}`,
  };
}

/** Appends `point`, widening the extents and the smoothed path to match. */
export function extendStroke(geometry: StrokeGeometry, point: PreviewAnnotationPoint): void {
  const previous = geometry.points[geometry.points.length - 1]!;
  // The quadratic through `previous` needs the point after it, so it can only
  // join the prefix now that `point` has arrived.
  if (geometry.points.length > 1) {
    geometry.prefix += ` Q ${previous.x} ${previous.y} ${(previous.x + point.x) / 2} ${(previous.y + point.y) / 2}`;
  }
  geometry.points.push(point);
  geometry.minX = Math.min(geometry.minX, point.x);
  geometry.minY = Math.min(geometry.minY, point.y);
  geometry.maxX = Math.max(geometry.maxX, point.x);
  geometry.maxY = Math.max(geometry.maxY, point.y);
}

/** The `d` attribute for the stroke as it stands. */
export function strokePath(geometry: StrokeGeometry): string {
  if (geometry.points.length === 1) return `${geometry.prefix} l 0.01 0.01`;
  const last = geometry.points[geometry.points.length - 1]!;
  return `${geometry.prefix} L ${last.x} ${last.y}`;
}

/** The stroke's painted extent, padded for the round cap of `width`. */
export function strokeBounds(geometry: StrokeGeometry, width: number): PreviewAnnotationRect {
  const padding = width + 3;
  const left = geometry.minX - padding;
  const top = geometry.minY - padding;
  const right = geometry.maxX + padding;
  const bottom = geometry.maxY + padding;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
