import { expect, it } from 'vitest';
import { dedupeForResolution } from '../src/weather';

it('queries coarse models at fewer points than fine ones', () => {
  // ~11 km north–south line sampled every ~280 m.
  const locs = Array.from({ length: 41 }, (_, i) => ({ lat: 51.45 + i * 0.0025, lon: -0.12 }));
  const fine = dedupeForResolution(locs, 2);
  const coarse = dedupeForResolution(locs, 25);
  expect(fine.unique.length).toBeGreaterThan(8);
  expect(coarse.unique.length).toBeLessThanOrEqual(2);
  expect(coarse.index).toHaveLength(locs.length);
  expect(coarse.index.every((u) => u < coarse.unique.length)).toBe(true);
});
