import { describe, expect, it } from 'vitest';
import type { RateFn, Scenario, Series } from '../src/rainModel';
import {
  buildRide,
  departureScan,
  evaluateEnsemble,
  evaluateScenario,
  forecastRoute,
  markovRouteProbability,
  neighbourhoodProbabilities,
  probabilityBounds,
  rateAt,
  weightedQuantile,
} from '../src/rainModel';

const T0 = 1_800_000_000 - (1_800_000_000 % 3600); // an hour boundary
const hourly = (values: (number | null)[]): Series => ({
  times: values.map((_, i) => T0 + (i + 1) * 3600),
  values,
  stepSec: 3600,
});

describe('rateAt', () => {
  it('uses the accumulation interval containing t', () => {
    const s = hourly([1, 2, 3]);
    expect(rateAt(s, T0)).toBe(1);
    expect(rateAt(s, T0 + 3599)).toBe(1);
    expect(rateAt(s, T0 + 3600)).toBe(2);
    expect(rateAt(s, T0 + 3 * 3600)).toBeNull();
    expect(rateAt(s, T0 - 1)).toBeNull();
  });

  it('converts 15-minute accumulations to mm/h', () => {
    const s: Series = { times: [T0 + 900, T0 + 1800], values: [0.5, null], stepSec: 900 };
    expect(rateAt(s, T0 + 10)).toBe(2);
    expect(rateAt(s, T0 + 1000)).toBeNull();
  });
});

describe('buildRide', () => {
  it('assigns arrival offsets and trapezoid time weights that sum to the ride time', () => {
    const ride = buildRide([0, 1000, 2000, 3000], [0, 0, 1, 1], 5);
    expect(ride.map((r) => r.offsetSec)).toEqual([0, 200, 400, 600]);
    expect(ride.reduce((a, r) => a + r.dtSec, 0)).toBeCloseTo(600);
  });
});

describe('evaluateScenario', () => {
  // 18 km at 5 m/s = 1 hour ride over two locations.
  const ride = buildRide([0, 9000, 18000], [0, 1, 1], 5);

  it('integrates a constant rate into exposure', () => {
    const r = evaluateScenario(() => 2, ride, T0)!;
    expect(r.exposureMm).toBeCloseTo(2);
    expect(r.maxRate).toBe(2);
  });

  it('follows you in space and time', () => {
    // Raining only at location 1, only in the second hour.
    const rate: RateFn = (loc, t) => (loc === 1 && t >= T0 + 3600 ? 4 : 0);
    expect(evaluateScenario(rate, ride, T0)!.rates).toEqual([0, 0, 4]);
    expect(evaluateScenario(rate, ride, T0 - 3600)!.maxRate).toBe(0);
  });

  it('is null if the forecast does not cover the ride', () => {
    expect(evaluateScenario((_, t) => (t > T0 + 100 ? null : 0), ride, T0)).toBeNull();
  });
});

describe('evaluateEnsemble', () => {
  const ride = buildRide([0, 1000], [0, 0], 5);
  const member = (r: number | null, model = 'A', modelWeight = 1): Scenario => ({ rate: () => r, model, modelWeight });

  it('is the fraction of members that meet rain', () => {
    const res = evaluateEnsemble([member(0), member(0), member(0.5), member(3)], ride, T0, 0.2)!;
    expect(res.probability).toBeCloseTo(0.5);
    expect(res.members).toBe(4);
    expect(res.sampleProb).toEqual([0.5, 0.5]);
  });

  it('splits each model weight across its members and drops members without data', () => {
    // Model A (weight 3): 1 dry member + 1 member missing → A says 0%.
    // Model B (weight 1): 2 wet members → B says 100%. Blend: 1/4.
    const res = evaluateEnsemble(
      [member(0, 'A', 3), member(null, 'A', 3), member(1, 'B', 1), member(1, 'B', 1)],
      ride,
      T0,
      0.2,
    )!;
    expect(res.probability).toBeCloseTo(0.25);
    expect(res.byModel).toEqual([
      expect.objectContaining({ model: 'A', members: 1, probability: 0 }),
      expect.objectContaining({ model: 'B', members: 2, probability: 1 }),
    ]);
  });

  it('is null with no usable members', () => {
    expect(evaluateEnsemble([member(null)], ride, T0, 0.2)).toBeNull();
  });
});

describe('departureScan', () => {
  it('finds the dry window', () => {
    // Raining for the first hour only.
    const sc: Scenario = { rate: (_, t) => (t < T0 + 3600 ? 2 : 0), model: 'A', modelWeight: 1 };
    const ride = buildRide([0, 3000], [0, 0], 5); // 10 min
    const opts = { thresholdMmH: 0.2, tauSec: 1200, highResWeight: 0.3, neighbourhood: { radiusM: 0, windowSec: 0, stepSec: 900 } };
    const scan = departureScan([sc], null, ride, T0, [0, 30, 60], opts);
    expect(scan.map((o) => o.result!.probability)).toEqual([1, 1, 0]);
  });
});

it('weightedQuantile', () => {
  expect(weightedQuantile([3, 1, 2], [1, 1, 1], 0.5)).toBe(2);
  expect(weightedQuantile([0, 10], [9, 1], 0.9)).toBe(0);
  expect(weightedQuantile([0, 10], [9, 1], 0.95)).toBe(10);
});

describe('route probability from per-point chances', () => {
  // 40 min ride, constant 20% chance it's raining at any given point.
  const rideAt = (n: number) => buildRide(Array.from({ length: n + 1 }, (_, i) => (i * 10000) / n), new Array(n + 1).fill(0), 10000 / 2400);
  const probs = (n: number) => new Array(n + 1).fill(0.2);

  it('bounds: independent blows up with sampling, fully-correlated does not', () => {
    expect(probabilityBounds(probs(10)).fullyCorrelated).toBeCloseTo(0.2);
    expect(probabilityBounds(probs(10)).independent).toBeCloseTo(1 - 0.8 ** 11);
    expect(probabilityBounds(probs(160)).independent).toBeGreaterThan(0.99);
  });

  it('Markov estimate sits between the bounds and converges as sampling gets finer', () => {
    const coarse = markovRouteProbability(probs(20), rideAt(20), 1200);
    const fine = markovRouteProbability(probs(400), rideAt(400), 1200);
    expect(coarse).toBeGreaterThan(0.2);
    expect(coarse).toBeLessThan(1 - 0.8 ** 21);
    expect(fine).toBeCloseTo(coarse, 1);
    // Continuous limit: 1 − q0·exp(−p·T/τ) = 1 − 0.8·exp(−0.2·2400/1200).
    expect(fine).toBeCloseTo(1 - 0.8 * Math.exp(-0.4), 2);
  });

  it('Markov tends to the bounds for very short / very long correlation times', () => {
    const ride = rideAt(10);
    expect(markovRouteProbability(probs(10), ride, 1e9)).toBeCloseTo(0.2, 3);
    expect(markovRouteProbability(probs(10), ride, 1)).toBeCloseTo(1 - 0.8 ** 11, 3);
  });

  it('neighbourhood probability counts wet neighbours in space and time', () => {
    const ride = buildRide([0, 1000, 2000], [0, 1, 2], 5);
    // Only location 2 is wet.
    const p = neighbourhoodProbabilities((loc) => (loc === 2 ? 1 : 0), ride, T0, 0.2, { radiusM: 1000, windowSec: 0, stepSec: 900 })!;
    expect(p).toEqual([0, 1 / 3, 1 / 2]);
  });

  it('forecastRoute blends ensemble and high-res', () => {
    const ride = buildRide([0, 1000], [0, 0], 5);
    const opts = { thresholdMmH: 0.2, tauSec: 1200, highResWeight: 0.25, neighbourhood: { radiusM: 0, windowSec: 0, stepSec: 900 } };
    const wetEnsemble: Scenario[] = [{ rate: () => 1, model: 'A', modelWeight: 1 }];
    const fc = forecastRoute(wetEnsemble, () => 0, ride, T0, opts)!;
    expect(fc.ensemble!.probability).toBe(1);
    expect(fc.highRes!.probability).toBeCloseTo(0);
    expect(fc.probability).toBeCloseTo(0.75);
    expect(forecastRoute([], () => 1, ride, T0, opts)!.probability).toBeCloseTo(1);
    expect(forecastRoute([], null, ride, T0, opts)).toBeNull();
  });
});
