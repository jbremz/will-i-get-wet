export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6371000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance from the start of the path to each vertex, in metres. */
export function cumulativeDistances(path: LatLon[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + haversine(path[i - 1], path[i]));
  return out;
}

/** Linearly interpolated position `d` metres along the path. */
export function pointAtDistance(path: LatLon[], cum: number[], d: number): LatLon {
  if (d <= 0) return path[0];
  if (d >= cum[cum.length - 1]) return path[path.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const f = seg === 0 ? 0 : (d - cum[lo]) / seg;
  return {
    lat: path[lo].lat + f * (path[hi].lat - path[lo].lat),
    lon: path[lo].lon + f * (path[hi].lon - path[lo].lon),
  };
}

/** The part of the path between `d0` and `d1` metres, following its vertices. */
export function slicePath(path: LatLon[], cum: number[], d0: number, d1: number): LatLon[] {
  const out = [pointAtDistance(path, cum, d0)];
  for (let i = 0; i < path.length; i++) if (cum[i] > d0 && cum[i] < d1) out.push(path[i]);
  out.push(pointAtDistance(path, cum, d1));
  return out;
}

export interface PathSample {
  point: LatLon;
  /** Metres from the start. */
  distance: number;
}

/** Evenly spaced samples along the path (at most `spacing` metres apart), including both ends. */
export function samplePath(path: LatLon[], spacing: number): PathSample[] {
  const cum = cumulativeDistances(path);
  const total = cum[cum.length - 1];
  const n = Math.max(1, Math.ceil(total / spacing));
  const out: PathSample[] = [];
  for (let k = 0; k <= n; k++) {
    const d = (total * k) / n;
    out.push({ point: pointAtDistance(path, cum, d), distance: d });
  }
  return out;
}

/** Distance along the path (metres) of the point on it closest to `p`. Flat-earth maths; fine at city scale. */
export function distanceAlong(path: LatLon[], cum: number[], p: LatLon): number {
  const kx = Math.cos((p.lat * Math.PI) / 180);
  let best = Infinity;
  let bestD = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i].lon * kx;
    const ay = path[i].lat;
    const dx = path[i + 1].lon * kx - ax;
    const dy = path[i + 1].lat - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.lon * kx - ax) * dx + (p.lat - ay) * dy) / len2));
    const ex = ax + t * dx - p.lon * kx;
    const ey = ay + t * dy - p.lat;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) {
      best = d2;
      bestD = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }
  return bestD;
}

/** Piecewise-linear interpolation of `values` sampled at increasing `at`. */
export function interpolate(at: number[], values: number[], x: number): number {
  if (x <= at[0]) return values[0];
  for (let i = 1; i < at.length; i++) {
    if (x <= at[i]) {
      const f = at[i] === at[i - 1] ? 0 : (x - at[i - 1]) / (at[i] - at[i - 1]);
      return values[i - 1] + f * (values[i] - values[i - 1]);
    }
  }
  return values[values.length - 1];
}
