import type { LatLon } from './geo';
import { cumulativeDistances } from './geo';

export type Mode = 'cycling' | 'walking';

export interface Route {
  path: LatLon[];
  /** Metres. */
  distance: number;
  /** Router's own estimate, seconds (we use the user's speed for ETAs). */
  duration: number;
  provider: string;
}

// FOSSGIS-hosted OSRM: free, no key, fair use. https://routing.openstreetmap.de/about.html
const OSRM_PROFILES: Record<Mode, string> = { cycling: 'routed-bike', walking: 'routed-foot' };
// openrouteservice: free key, 2000 directions/day. https://openrouteservice.org/dev/#/signup
const ORS_PROFILES: Record<Mode, string> = { cycling: 'cycling-regular', walking: 'foot-walking' };

const toLatLon = ([lon, lat]: number[]): LatLon => ({ lat, lon });

async function osrmRoutes(a: LatLon, b: LatLon, mode: Mode): Promise<Route[]> {
  const url =
    `https://routing.openstreetmap.de/${OSRM_PROFILES[mode]}/route/v1/driving/` +
    `${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&alternatives=true`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.code !== 'Ok') throw new Error(json.message ?? json.code);
  return json.routes.map((r: any) => ({
    path: r.geometry.coordinates.map(toLatLon),
    distance: r.distance,
    duration: r.duration,
    provider: 'OSRM (FOSSGIS)',
  }));
}

async function orsRoutes(a: LatLon, b: LatLon, mode: Mode, key: string): Promise<Route[]> {
  const res = await fetch(`https://api.openrouteservice.org/v2/directions/${ORS_PROFILES[mode]}/geojson`, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      coordinates: [
        [a.lon, a.lat],
        [b.lon, b.lat],
      ],
      alternative_routes: { target_count: 3, share_factor: 0.6, weight_factor: 1.6 },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? res.statusText);
  return json.features.map((f: any) => ({
    path: f.geometry.coordinates.map(toLatLon),
    distance: f.properties.summary.distance,
    duration: f.properties.summary.duration,
    provider: 'openrouteservice',
  }));
}

export function crowFliesRoute(a: LatLon, b: LatLon): Route {
  const path = [a, b];
  return { path, distance: cumulativeDistances(path)[1], duration: 0, provider: 'As the crow flies' };
}

/** Real routes if a router answers; falls back to a straight line so you always get a forecast. */
export async function getRoutes(
  a: LatLon,
  b: LatLon,
  mode: Mode,
  orsKey?: string,
): Promise<{ routes: Route[]; warning?: string }> {
  try {
    const routes = orsKey ? await orsRoutes(a, b, mode, orsKey) : await osrmRoutes(a, b, mode);
    if (routes.length) return { routes };
    throw new Error('no route found');
  } catch (e) {
    return { routes: [crowFliesRoute(a, b)], warning: `Routing failed (${(e as Error).message}); using a straight line.` };
  }
}
