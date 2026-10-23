import type { LatLon } from './geo';

// Photon (komoot): free, no key, OSM-based, supports type-ahead. https://photon.komoot.io
const PHOTON = 'https://photon.komoot.io';

export interface Place {
  label: string;
  point: LatLon;
}

function label(p: Record<string, string | undefined>): string {
  const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street;
  const parts = [p.name, street, p.district ?? p.locality, p.city, p.country].filter(Boolean);
  return [...new Set(parts)].slice(0, 4).join(', ');
}

function toPlaces(json: any): Place[] {
  return json.features.map((f: any) => ({
    label: label(f.properties),
    point: { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] },
  }));
}

export async function search(query: string, bias?: LatLon): Promise<Place[]> {
  const params = new URLSearchParams({ q: query, limit: '6' });
  if (bias) {
    params.set('lat', bias.lat.toFixed(4));
    params.set('lon', bias.lon.toFixed(4));
  }
  const res = await fetch(`${PHOTON}/api/?${params}`);
  return toPlaces(await res.json());
}

export async function reverse(point: LatLon): Promise<Place> {
  const fallback = { label: `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`, point };
  try {
    const res = await fetch(`${PHOTON}/reverse?lat=${point.lat}&lon=${point.lon}`);
    const [place] = toPlaces(await res.json());
    return place ? { label: place.label, point } : fallback;
  } catch {
    return fallback;
  }
}
