import type { PreviewAnnotationPoint, PreviewAnnotationRect } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { beginStroke, extendStroke, strokeBounds, strokePath } from "./AnnotationStroke.ts";

/**
 * The rescan-everything implementations these helpers replaced. Kept here as
 * the oracle for the incremental versions: same output, without the per-point
 * copy, rescan and rebuild.
 */
const naivePath = (points: ReadonlyArray<PreviewAnnotationPoint>): string => {
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y} l 0.01 0.01`;
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    path += ` Q ${current.x} ${current.y} ${(current.x + next.x) / 2} ${(current.y + next.y) / 2}`;
  }
  const last = points[points.length - 1]!;
  path += ` L ${last.x} ${last.y}`;
  return path;
};

const naiveBounds = (
  points: ReadonlyArray<PreviewAnnotationPoint>,
  width: number,
): PreviewAnnotationRect => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = width + 3;
  const left = Math.min(...xs) - padding;
  const top = Math.min(...ys) - padding;
  const right = Math.max(...xs) + padding;
  const bottom = Math.max(...ys) + padding;
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/** Deterministic jitter, so a failure is reproducible. */
const wobble = (count: number): Array<PreviewAnnotationPoint> => {
  const points: Array<PreviewAnnotationPoint> = [];
  let seed = 7;
  for (let index = 0; index < count; index += 1) {
    seed = (seed * 48271) % 2147483647;
    points.push({ x: index + (seed % 17), y: 400 - (seed % 29) });
  }
  return points;
};

describe("stroke geometry", () => {
  it("matches the full-rescan path and bounds at every length", () => {
    const points = wobble(200);
    const geometry = beginStroke(points[0]!);
    for (let index = 1; index < points.length; index += 1) {
      extendStroke(geometry, points[index]!);
      const seen = points.slice(0, index + 1);
      expect(strokePath(geometry)).toBe(naivePath(seen));
      expect(strokeBounds(geometry, 4)).toEqual(naiveBounds(seen, 4));
    }
  });

  it("renders a single point as a dot", () => {
    const geometry = beginStroke({ x: 12, y: 34 });
    expect(strokePath(geometry)).toBe("M 12 34 l 0.01 0.01");
    expect(strokeBounds(geometry, 4)).toEqual({ x: 5, y: 27, width: 14, height: 14 });
  });

  it("appends in place so the stroke target sees every point", () => {
    const geometry = beginStroke({ x: 0, y: 0 });
    const points = geometry.points;
    extendStroke(geometry, { x: 5, y: 5 });
    expect(geometry.points).toBe(points);
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ]);
  });

  it("survives a stroke longer than the engine's argument limit", () => {
    // `Math.min(...xs)` throws RangeError somewhere past ~100k arguments, and a
    // per-point rescan would not finish this inside the test timeout.
    const geometry = beginStroke({ x: 0, y: 0 });
    for (let index = 1; index < 250_000; index += 1) {
      extendStroke(geometry, { x: index % 800, y: index % 600 });
    }
    expect(geometry.points).toHaveLength(250_000);
    expect(strokeBounds(geometry, 4)).toEqual({ x: -7, y: -7, width: 813, height: 613 });
    expect(strokePath(geometry)).toMatch(/^M 0 0 Q /);
  });
});
