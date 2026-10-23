/**
 * Pure maths for "will I get rained on?". No network, no DOM — everything here is unit-tested.
 *
 * A forecast *scenario* is a function giving the rain rate (mm/h) at a weather location and time.
 * A *ride* is a list of samples along the route, each tied to a weather location, a time offset from
 * departure, and the time spent around that sample. Integrating rate × time over the ride gives the
 * rain that falls on you; checking the peak rate tells you whether you got rained on at all.
 *
 * Ensemble forecasts give many equally plausible scenarios, each coherent in space and time, so the
 * chance of rain on the *whole route* is just the (weighted) fraction of scenarios in which you hit
 * rain. That sidesteps the correlation problem of combining per-point probabilities.
 */

export interface Series {
  /** Unix seconds marking the END of each accumulation interval (Open-Meteo convention). */
  times: number[];
  /** mm accumulated over (time - stepSec, time]. */
  values: (number | null)[];
  stepSec: number;
}

/** Rain rate in mm/h at weather location `loc` and unix time `t`, or null if unknown. */
export type RateFn = (loc: number, t: number) => number | null;

/** Rain rate (mm/h) during the accumulation interval containing `t`. */
export function rateAt(s: Series | undefined, t: number): number | null {
  if (!s || s.times.length === 0) return null;
  // First interval end strictly after t → interval [end - step, end) contains t.
  let lo = 0;
  let hi = s.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s.times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= s.times.length || s.times[lo] - s.stepSec > t) return null;
  const v = s.values[lo];
  return v == null ? null : (v * 3600) / s.stepSec;
}

export interface RideSample {
  /** Seconds after departure that you reach this sample. */
  offsetSec: number;
  /** Seconds of the ride attributed to this sample (trapezoid weights). */
  dtSec: number;
  /** Index into the weather location list. */
  loc: number;
  /** Metres from the start. */
  distance: number;
}

export function buildRide(distances: number[], locs: number[], speedMps: number): RideSample[] {
  const n = distances.length;
  return distances.map((d, i) => {
    const prev = distances[Math.max(0, i - 1)];
    const next = distances[Math.min(n - 1, i + 1)];
    return { offsetSec: d / speedMps, dtSec: (next - prev) / 2 / speedMps, loc: locs[i], distance: d };
  });
}

export interface ScenarioResult {
  /** Rain falling on you over the ride, mm. */
  exposureMm: number;
  /** Peak rain rate encountered, mm/h. */
  maxRate: number;
  /** Rain rate at each ride sample, mm/h. */
  rates: number[];
}

/** Integrate one scenario along the ride. Null if the forecast doesn't cover the whole ride. */
export function evaluateScenario(rate: RateFn, ride: RideSample[], departure: number): ScenarioResult | null {
  const rates: number[] = [];
  let exposureMm = 0;
  let maxRate = 0;
  for (const s of ride) {
    const r = rate(s.loc, departure + s.offsetSec);
    if (r == null) return null;
    rates.push(r);
    exposureMm += (r * s.dtSec) / 3600;
    maxRate = Math.max(maxRate, r);
  }
  return { exposureMm, maxRate, rates };
}

export interface Scenario {
  rate: RateFn;
  model: string;
  /** Total vote of this scenario's model; shared equally among its members that cover the ride. */
  modelWeight: number;
}

export interface ModelBreakdown {
  model: string;
  members: number;
  probability: number;
  meanMm: number;
}

export interface EnsembleResult {
  /** Weighted fraction of scenarios with rain ≥ threshold somewhere on your ride. */
  probability: number;
  meanMm: number;
  p90Mm: number;
  /** Per ride sample: chance it's raining (≥ threshold) as you pass. */
  sampleProb: number[];
  members: number;
  byModel: ModelBreakdown[];
}

export function weightedQuantile(values: number[], weights: number[], q: number): number {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const i of order) {
    acc += weights[i];
    if (acc >= q * total - 1e-12) return values[i];
  }
  return values[order[order.length - 1]];
}

export function evaluateEnsemble(
  scenarios: Scenario[],
  ride: RideSample[],
  departure: number,
  thresholdMmH: number,
): EnsembleResult | null {
  const byModel = new Map<string, { modelWeight: number; results: ScenarioResult[] }>();
  for (const sc of scenarios) {
    const res = evaluateScenario(sc.rate, ride, departure);
    if (!res) continue;
    const entry = byModel.get(sc.model) ?? { modelWeight: sc.modelWeight, results: [] };
    entry.results.push(res);
    byModel.set(sc.model, entry);
  }
  if (byModel.size === 0) return null;

  const results: ScenarioResult[] = [];
  const weights: number[] = [];
  const breakdown: ModelBreakdown[] = [];
  for (const [model, { modelWeight, results: rs }] of byModel) {
    const wet = rs.filter((r) => r.maxRate >= thresholdMmH).length;
    breakdown.push({
      model,
      members: rs.length,
      probability: wet / rs.length,
      meanMm: rs.reduce((a, r) => a + r.exposureMm, 0) / rs.length,
    });
    for (const r of rs) {
      results.push(r);
      weights.push(modelWeight / rs.length);
    }
  }

  const total = weights.reduce((a, b) => a + b, 0);
  const weightedShare = (pred: (r: ScenarioResult) => boolean) =>
    results.reduce((acc, r, i) => acc + (pred(r) ? weights[i] : 0), 0) / total;

  return {
    probability: weightedShare((r) => r.maxRate >= thresholdMmH),
    meanMm: results.reduce((acc, r, i) => acc + r.exposureMm * weights[i], 0) / total,
    p90Mm: weightedQuantile(
      results.map((r) => r.exposureMm),
      weights,
      0.9,
    ),
    sampleProb: ride.map((_, j) => weightedShare((r) => r.rates[j] >= thresholdMmH)),
    members: results.length,
    byModel: breakdown,
  };
}


// ---------- combining per-point chances into a whole-route chance ----------
//
// Per-point chances p_i ("is it raining where I am at that moment?") don't determine the route
// chance on their own — that needs to know how rain at one point relates to rain at the next.
// They do bound it: max p_i (one rain system, fully correlated) ≤ P(wet) ≤ 1 − Π(1 − p_i)
// (independent points; grows with sampling density, so it's an overestimate in practice).
//
// The middle ground models "is it raining where I am" as a two-state (dry/wet) Markov process with
// correlation time τ — how long the rain situation you're riding through stays similar. Between
// consecutive samples the dry→dry probability keeps the marginals and correlation ρ = exp(−Δt/τ):
//   P(dry_i, dry_{i−1}) = q_{i−1}q_i + ρ·√(q_{i−1}p_{i−1}q_i p_i)     (q = 1 − p)
//   P(dry all the way) = q_0 · Π P(dry_i, dry_{i−1}) / q_{i−1}
// As Δt → 0 this becomes P(dry) = q_0 · exp(−∫ p(t)/τ dt): the hazard integral, independent of how
// finely the route is sampled. τ → 0 gives the independent case; τ → ∞ the fully correlated one.

export interface RouteProbabilityBounds {
  /** max p_i — everything perfectly correlated. */
  fullyCorrelated: number;
  /** 1 − Π(1 − p_i) — every sample independent. */
  independent: number;
}

export function probabilityBounds(probs: number[]): RouteProbabilityBounds {
  return {
    fullyCorrelated: Math.max(0, ...probs),
    independent: 1 - probs.reduce((acc, p) => acc * (1 - p), 1),
  };
}

export function markovRouteProbability(probs: number[], ride: RideSample[], tauSec: number): number {
  const clamp = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p));
  let pDry = 1 - clamp(probs[0]);
  for (let i = 1; i < probs.length; i++) {
    const p0 = clamp(probs[i - 1]);
    const p1 = clamp(probs[i]);
    const q0 = 1 - p0;
    const q1 = 1 - p1;
    const rho = Math.exp(-(ride[i].offsetSec - ride[i - 1].offsetSec) / tauSec);
    // Joint dry probability, kept inside the Fréchet bounds.
    const joint = Math.min(Math.min(q0, q1), Math.max(q0 + q1 - 1, q0 * q1 + rho * Math.sqrt(q0 * p0 * q1 * p1)));
    pDry *= joint / q0;
  }
  return 1 - pDry;
}

export interface NeighbourhoodOptions {
  /** Count samples within this many metres along the route as neighbours. */
  radiusM: number;
  /** Look this many seconds either side of your ETA (timing errors). */
  windowSec: number;
  stepSec: number;
}

/**
 * Turn one deterministic forecast into per-point chances with a "neighbourhood" — the fraction of
 * nearby places and times with rain ≥ threshold. High-res models get showers roughly right but
 * misplace them by a few km / tens of minutes, so this is the standard way to read them
 * probabilistically. Null if the forecast has no data for the ride.
 */
export function neighbourhoodProbabilities(
  rate: RateFn,
  ride: RideSample[],
  departure: number,
  thresholdMmH: number,
  { radiusM, windowSec, stepSec }: NeighbourhoodOptions,
): number[] | null {
  const out: number[] = [];
  for (const s of ride) {
    const t = departure + s.offsetSec;
    let wet = 0;
    let n = 0;
    for (const nb of ride) {
      if (Math.abs(nb.distance - s.distance) > radiusM) continue;
      for (let dt = -windowSec; dt <= windowSec; dt += stepSec) {
        const r = rate(nb.loc, t + dt);
        if (r == null) continue;
        n++;
        if (r >= thresholdMmH) wet++;
      }
    }
    if (n === 0) return null;
    out.push(wet / n);
  }
  return out;
}

export interface ForecastOptions {
  thresholdMmH: number;
  /** Rain correlation time along your path, seconds. */
  tauSec: number;
  /** Share of the headline given to the high-res forecast when both are available. */
  highResWeight: number;
  neighbourhood: NeighbourhoodOptions;
}

export interface RouteForecast {
  /** Headline: blend of the ensemble and the high-res estimates. */
  probability: number;
  /** Per ride sample, blended the same way. */
  sampleProb: number[];
  ensemble: EnsembleResult | null;
  /** From ensemble per-point chances: the bounds and the Markov estimate. */
  ensembleCrossCheck: (RouteProbabilityBounds & { markov: number }) | null;
  highRes: { probability: number; sampleProb: number[] } | null;
}

export function forecastRoute(
  scenarios: Scenario[],
  highResRate: RateFn | null,
  ride: RideSample[],
  departure: number,
  opts: ForecastOptions,
): RouteForecast | null {
  const ensemble = evaluateEnsemble(scenarios, ride, departure, opts.thresholdMmH);
  const hrProbs = highResRate
    ? neighbourhoodProbabilities(highResRate, ride, departure, opts.thresholdMmH, opts.neighbourhood)
    : null;
  const highRes = hrProbs ? { probability: markovRouteProbability(hrProbs, ride, opts.tauSec), sampleProb: hrProbs } : null;
  if (!ensemble && !highRes) return null;

  const w = ensemble && highRes ? opts.highResWeight : highRes ? 1 : 0;
  const mix = (a: number, b: number) => (1 - w) * a + w * b;
  return {
    probability: mix(ensemble?.probability ?? 0, highRes?.probability ?? 0),
    sampleProb: ride.map((_, i) => mix(ensemble?.sampleProb[i] ?? 0, highRes?.sampleProb[i] ?? 0)),
    ensemble,
    ensembleCrossCheck: ensemble
      ? { ...probabilityBounds(ensemble.sampleProb), markov: markovRouteProbability(ensemble.sampleProb, ride, opts.tauSec) }
      : null,
    highRes,
  };
}

export interface DepartureOption {
  offsetMin: number;
  result: RouteForecast | null;
}

/** Re-run the forecast for a range of departure times — no extra forecast data needed. */
export function departureScan(
  scenarios: Scenario[],
  highResRate: RateFn | null,
  ride: RideSample[],
  now: number,
  offsetsMin: number[],
  opts: ForecastOptions,
): DepartureOption[] {
  return offsetsMin.map((offsetMin) => ({
    offsetMin,
    result: forecastRoute(scenarios, highResRate, ride, now + offsetMin * 60, opts),
  }));
}
