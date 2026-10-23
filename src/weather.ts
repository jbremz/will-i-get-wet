import type { LatLon } from './geo';
import type { RateFn, Scenario, Series } from './rainModel';
import { rateAt } from './rainModel';

// Open-Meteo: free, no key, non-commercial use. https://open-meteo.com/en/terms
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';

export interface EnsembleModel {
  id: string;
  label: string;
  resolutionKm: number;
  /**
   * Total vote this model gets in the blended probability, split among its members. High-res
   * convection-permitting models get more say. Regional models that don't cover the route just drop
   * out, so the same list works for London or anywhere else.
   */
  weight: number;
}

export const ENSEMBLE_MODELS: EnsembleModel[] = [
  { id: 'icon_d2_eps', label: 'DWD ICON-D2 EPS', resolutionKm: 2, weight: 4 },
  { id: 'ukmo_uk_ensemble_2km', label: 'Met Office MOGREPS-UK', resolutionKm: 2, weight: 2 },
  { id: 'icon_eu_eps', label: 'DWD ICON-EU EPS', resolutionKm: 13, weight: 2 },
  { id: 'ukmo_global_ensemble_20km', label: 'Met Office MOGREPS-G', resolutionKm: 20, weight: 1 },
  { id: 'ecmwf_ifs025', label: 'ECMWF IFS ENS', resolutionKm: 25, weight: 1 },
  { id: 'gfs025', label: 'NOAA GEFS', resolutionKm: 25, weight: 1 },
];

export interface EnsembleData {
  model: EnsembleModel;
  /** members[m][loc] */
  members: Series[][];
}

/** Highest-resolution deterministic forecast Open-Meteo has for each location ("best_match"). */
export interface DeterministicData {
  minutely: Series[];
  hourly: Series[];
}

export interface WeatherData {
  deterministic: DeterministicData | null;
  ensembles: EnsembleData[];
  failures: string[];
  /** Unix seconds up to which forecasts were requested. */
  coversUntil: number;
}

type OMLocation = Record<string, any>;

function coordParams(locs: LatLon[]): Record<string, string> {
  return {
    latitude: locs.map((l) => l.lat.toFixed(4)).join(','),
    longitude: locs.map((l) => l.lon.toFixed(4)).join(','),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getLocations(base: string, params: Record<string, string>, retries = 2): Promise<OMLocation[]> {
  const res = await fetch(`${base}?${new URLSearchParams(params)}`);
  // Open-Meteo answers 429 when too many requests are in flight; back off and retry.
  if (res.status === 429 && retries > 0) {
    await sleep(800 * (3 - retries));
    return getLocations(base, params, retries - 1);
  }
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.reason ?? res.statusText);
  return Array.isArray(json) ? json : [json];
}

/** Like Promise.allSettled, but at most `limit` tasks in flight. */
async function settleLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

/**
 * Collapse locations that fall in the same half-grid-cell of a model with the given resolution, so a
 * 25 km model is queried at one or two points rather than at every sample along the route. Open-Meteo
 * bills each location (and ensemble members) against the free rate limit.
 */
export function dedupeForResolution(locs: LatLon[], resolutionKm: number): { unique: LatLon[]; index: number[] } {
  const cellDeg = resolutionKm / 2 / 111;
  const unique: LatLon[] = [];
  const seen = new Map<string, number>();
  const index = locs.map((l) => {
    const lonCell = cellDeg / Math.max(0.1, Math.cos((l.lat * Math.PI) / 180));
    const key = `${Math.round(l.lat / cellDeg)},${Math.round(l.lon / lonCell)}`;
    if (!seen.has(key)) {
      seen.set(key, unique.length);
      unique.push(l);
    }
    return seen.get(key)!;
  });
  return { unique, index };
}

/** Best-match models are ~1–2 km where high-res models exist (e.g. UKV in the UK). */
const DETERMINISTIC_RESOLUTION_KM = 1.5;

export async function fetchDeterministic(allLocs: LatLon[], hours: number): Promise<DeterministicData> {
  const { unique, index } = dedupeForResolution(allLocs, DETERMINISTIC_RESOLUTION_KM);
  const data = await getLocations(FORECAST_URL, {
    ...coordParams(unique),
    hourly: 'precipitation',
    minutely_15: 'precipitation',
    forecast_hours: String(hours),
    forecast_minutely_15: String(hours * 4),
    timeformat: 'unixtime',
  });
  return {
    minutely: index.map((u) => ({ times: data[u].minutely_15.time, values: data[u].minutely_15.precipitation, stepSec: 900 })),
    hourly: index.map((u) => ({ times: data[u].hourly.time, values: data[u].hourly.precipitation, stepSec: 3600 })),
  };
}

export async function fetchEnsemble(model: EnsembleModel, allLocs: LatLon[], hours: number): Promise<EnsembleData> {
  const { unique, index } = dedupeForResolution(allLocs, model.resolutionKm);
  const data = await getLocations(ENSEMBLE_URL, {
    ...coordParams(unique),
    hourly: 'precipitation',
    models: model.id,
    forecast_hours: String(hours),
    timeformat: 'unixtime',
  });
  // Single-model requests give `precipitation` (control run) plus `precipitation_memberNN`.
  const keys = Object.keys(data[0].hourly).filter((k) => k === 'precipitation' || k.startsWith('precipitation_member'));
  return {
    model,
    members: keys.map((k) => {
      const series = data.map((l): Series => ({ times: l.hourly.time, values: l.hourly[k], stepSec: 3600 }));
      return index.map((u) => series[u]);
    }),
  };
}

export async function fetchWeather(locs: LatLon[], hours: number): Promise<WeatherData> {
  const [det, ...ens] = await settleLimited<any>(
    [() => fetchDeterministic(locs, hours), ...ENSEMBLE_MODELS.map((m) => () => fetchEnsemble(m, locs, hours))],
    3,
  );
  const ensembles: EnsembleData[] = [];
  const failures: string[] = [];
  ens.forEach((r, i) => {
    if (r.status === 'fulfilled') ensembles.push(r.value);
    else failures.push(`${ENSEMBLE_MODELS[i].label}: ${(r.reason as Error).message}`);
  });
  if (det.status === 'rejected') failures.push(`Deterministic: ${(det.reason as Error).message}`);
  const hourStart = Math.floor(Date.now() / 3_600_000) * 3600;
  return {
    deterministic: det.status === 'fulfilled' ? det.value : null,
    ensembles,
    failures,
    coversUntil: hourStart + hours * 3600,
  };
}

export function ensembleScenarios(ensembles: EnsembleData[]): Scenario[] {
  return ensembles.flatMap(({ model, members }) =>
    members.map((series) => ({
      model: model.label,
      modelWeight: model.weight,
      rate: ((loc, t) => rateAt(series[loc], t)) as RateFn,
    })),
  );
}

/** 15-minute data where available, hourly otherwise. */
export function deterministicRate(det: DeterministicData): RateFn {
  return (loc, t) => rateAt(det.minutely[loc], t) ?? rateAt(det.hourly[loc], t);
}
