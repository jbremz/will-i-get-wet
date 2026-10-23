import { describe, expect, it } from 'vitest';
import { cumulativeDistances, distanceAlong, haversine, interpolate, pointAtDistance, samplePath, slicePath } from '../src/geo';

const path = [
  { lat: 51.5, lon: -0.1 },
  { lat: 51.51, lon: -0.1 },
  { lat: 51.51, lon: -0.08 },
];

describe('geo', () => {
  it('haversine ≈ 1.11 km per 0.01° latitude', () => {
    expect(haversine(path[0], path[1])).toBeCloseTo(1112, -1);
  });

  it('interpolates along the path', () => {
    const cum = cumulativeDistances(path);
    const mid = pointAtDistance(path, cum, cum[1] / 2);
    expect(mid.lat).toBeCloseTo(51.505);
    expect(pointAtDistance(path, cum, 1e9)).toEqual(path[2]);
  });

  it('samples evenly including both ends', () => {
    const s = samplePath(path, 500);
    const cum = cumulativeDistances(path);
    expect(s[0].point).toEqual(path[0]);
    expect(s.at(-1)!.point).toEqual(path[2]);
    expect(s.at(-1)!.distance).toBeCloseTo(cum[2]);
    for (let i = 1; i < s.length; i++) expect(s[i].distance - s[i - 1].distance).toBeLessThanOrEqual(500);
  });

  it('slices keep interior vertices', () => {
    const cum = cumulativeDistances(path);
    const slice = slicePath(path, cum, cum[1] - 10, cum[1] + 10);
    expect(slice).toHaveLength(3);
    expect(slice[1]).toEqual(path[1]);
  });

  it('finds how far along the path a nearby point is', () => {
    const cum = cumulativeDistances(path);
    // Just east of the midpoint of the first (north–south) leg.
    expect(distanceAlong(path, cum, { lat: 51.505, lon: -0.0995 })).toBeCloseTo(cum[1] / 2, -1);
    expect(distanceAlong(path, cum, { lat: 51.52, lon: -0.07 })).toBeCloseTo(cum[2]);
  });

  it('interpolates linearly between samples and clamps at the ends', () => {
    expect(interpolate([0, 10, 20], [0, 1, 3], 15)).toBeCloseTo(2);
    expect(interpolate([0, 10, 20], [0, 1, 3], -5)).toBe(0);
    expect(interpolate([0, 10, 20], [0, 1, 3], 99)).toBe(3);
  });
});
