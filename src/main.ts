import 'leaflet/dist/leaflet.css';
import './design/tokens.css';
import './design/bundle.css';
import './style.css';
import L from 'leaflet';
import type { LatLon, PathSample } from './geo';
import { cumulativeDistances, distanceAlong, interpolate, samplePath, slicePath } from './geo';
import type { Place } from './geocode';
import { reverse, search } from './geocode';
import type { DepartureOption, ForecastOptions, RideSample, RouteForecast, Scenario, ScenarioResult } from './rainModel';
import { buildRide, departureScan, evaluateScenario, forecastRoute } from './rainModel';
import type { Mode, Route } from './routing';
import { getRoutes } from './routing';
import type { WeatherData } from './weather';
import { deterministicRate, ensembleScenarios, fetchWeather } from './weather';

const DEPART_OFFSETS_MIN = Array.from({ length: 13 }, (_, i) => i * 15); // now … +3h
const DEFAULT_SPEED_KMH: Record<Mode, number> = { cycling: 16, walking: 5 };
const WEATHER_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_SAMPLES_PER_ROUTE = 40;
/** Share of the headline given to the 15-minute high-res forecast; the rest is the ensemble. */
const HIGH_RES_WEIGHT = 0.3;
/** Neighbourhood for reading the high-res forecast as a probability: ±2 km along the route, ±30 min. */
const NEIGHBOURHOOD = { radiusM: 2000, windowSec: 1800, stepSec: 900 };
const LONDON: L.LatLngTuple = [51.5074, -0.1278];
/** The Scribble component's note arrow, from small bean behaviour. */
const SCRIBBLE_ARROW = 'M 38 4 C 26 6, 14 12, 6 24 M 6 24 L 5 14 M 6 24 L 15 21';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const fromInput = $<HTMLInputElement>('#from');
const toInput = $<HTMLInputElement>('#to');
const speedInput = $<HTMLInputElement>('#speed');
const departSelect = $<HTMLSelectElement>('#depart');
const thresholdSelect = $<HTMLSelectElement>('#threshold');
const tauSelect = $<HTMLSelectElement>('#tau');
const orsKeyInput = $<HTMLInputElement>('#ors-key');
const statusEl = $('#status');
const resultsEl = $('#results');

// ---------- state ----------

interface Prepared {
  key: string;
  routes: Route[];
  samples: PathSample[][];
  locIdx: number[][];
  weather: WeatherData;
  scenarios: Scenario[];
  fetchedAt: number;
  warning?: string;
}

interface RouteEval {
  ride: RideSample[];
  fc: RouteForecast | null;
  det: ScenarioResult | null;
  scan: DepartureOption[];
}

const state: {
  from: Place | null;
  to: Place | null;
  prepared: Prepared | null;
  evals: RouteEval[];
  selected: number;
} = { from: null, to: null, prepared: null, evals: [], selected: 0 };

const settings = () => ({
  mode: (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value as Mode,
  speedKmh: Math.max(1, Number(speedInput.value) || 15),
  departMin: Number(departSelect.value),
  threshold: Number(thresholdSelect.value),
  tauMin: Number(tauSelect.value),
  orsKey: orsKeyInput.value.trim() || undefined,
});

// ---------- theme ----------

/** Theme colours as [r, g, b] 0–255, read from the design tokens. */
function ink(name: string): number[] {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
  probe.remove();
  return rgb;
}

const mix = (a: number[], b: number[], f: number) => a.map((c, i) => c + f * (b[i] - c));
const rgb = (c: number[]) => `rgb(${c.map(Math.round).join(',')})`;

let palette = readPalette();
function readPalette() {
  return { paper: ink('--paper-raised'), ink1: ink('--ink-1'), ink2: ink('--ink-2'), text: ink('--text') };
}

/** Replace the colour rows of a mask-style colour matrix, keeping its alpha (mask) row. */
function setPlateInk(el: Element, [r, g, b]: number[]) {
  const alphaRow = el.getAttribute('values')!.trim().split(/\s+/).slice(15).join(' ');
  el.setAttribute('values', `0 0 0 0 ${r / 255}  0 0 0 0 ${g / 255}  0 0 0 0 ${b / 255}  ${alphaRow}`);
}

/** Point the SVG print filters at the current inks: map in ink-1 on paper, radar (rain) in ink-2. */
function applyPrintFilters() {
  const map = ink('--paper');
  // Map ink is pulled 15% towards the paper so routes still print on top of it.
  const mapInk = palette.ink1.map((c, i) => c + 0.15 * (map[i] - c));
  const funcs = document.querySelectorAll('#map-duotone-inks > *');
  funcs.forEach((f, i) => f.setAttribute('tableValues', `${mapInk[i] / 255} ${map[i] / 255}`));
  setPlateInk(document.querySelector('#map-parks')!, palette.ink1);
  setPlateInk(document.querySelector('#map-water')!, palette.ink1);
  // Ink darkens light paper (multiply); on night paper the inks are the light colours, so they screen.
  const night = document.documentElement.dataset.theme?.endsWith('-night');
  document.querySelectorAll('#map-duotone .map-plate').forEach((b) => b.setAttribute('mode', night ? 'screen' : 'multiply'));
  document.querySelectorAll('#radar-ink .radar-plate').forEach((el) => setPlateInk(el, palette.ink2));
}

/** Expected rain rate (mm/h) at which each ink in `rateInks()` is reached. */
const RATE_STOPS = [0, 0.1, 0.5, 2, 6];
/** Bare paper when dry, building up to solid ink-1 for steady rain, then ink-2 (as on the radar) when heavy. */
const rateInks = () => [
  palette.paper,
  mix(palette.paper, palette.ink1, 0.25),
  mix(palette.paper, palette.ink1, 0.6),
  palette.ink1,
  palette.ink2,
];
function rateColor(r: number): string {
  const inks = rateInks();
  for (let i = 1; i < RATE_STOPS.length; i++) {
    if (r <= RATE_STOPS[i]) return rgb(mix(inks[i - 1], inks[i], (r - RATE_STOPS[i - 1]) / (RATE_STOPS[i] - RATE_STOPS[i - 1])));
  }
  return rgb(inks[inks.length - 1]);
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  document.documentElement.dataset.theme = e.matches ? 'cobalt-tomato-night' : 'cobalt-tomato';
  palette = readPalette();
  applyPrintFilters();
  if (state.prepared) render();
});
applyPrintFilters();

// ---------- map ----------

const map = L.map('map', { zoomControl: false }).setView(LONDON, 12);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
map.createPane('radar').style.zIndex = '350';
const routeLayer = L.layerGroup().addTo(map);
// The rain gradient is hundreds of short segments; canvas draws them far faster than SVG.
const routeCanvas = L.canvas({ padding: 0.5 });

const rateLegend = new L.Control({ position: 'bottomleft' });
rateLegend.onAdd = () => L.DomUtil.create('div', 'rate-legend');

const pin = (text: string, cls: string) =>
  L.divIcon({ className: `pin ${cls}`, html: `<span>${text}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
const markers: Record<'from' | 'to', L.Marker | null> = { from: null, to: null };

function setPlace(which: 'from' | 'to', place: Place | null, { recompute = true } = {}) {
  state[which] = place;
  (which === 'from' ? fromInput : toInput).value = place?.label ?? '';
  markers[which]?.remove();
  markers[which] = null;
  if (place) {
    const m = L.marker([place.point.lat, place.point.lon], {
      icon: pin(which === 'from' ? 'A' : 'B', which),
      draggable: true,
    }).addTo(map);
    m.on('dragend', async () => {
      const { lat, lng } = m.getLatLng();
      setPlace(which, await reverse({ lat, lon: lng }));
    });
    markers[which] = m;
  }
  if (recompute && state.from && state.to) run();
}

map.on('click', async (e: L.LeafletMouseEvent) => {
  const which = !state.from ? 'from' : 'to';
  setPlace(which, await reverse({ lat: e.latlng.lat, lon: e.latlng.lng }));
});

// RainViewer's latest radar frame as a toggleable overlay (free tier serves zoom ≤ 7, upscaled).
async function addRadarLayer() {
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    const json = await res.json();
    const frame = json.radar.past.at(-1);
    const radar = L.tileLayer(`${json.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      pane: 'radar',
      opacity: 0.85,
      maxNativeZoom: 7,
      maxZoom: 19,
      attribution: 'Radar © <a href="https://www.rainviewer.com/">RainViewer</a>',
    });
    const time = new Date(frame.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    L.control.layers(undefined, { [`Radar, ${time}`]: radar }, { position: 'topright', collapsed: window.innerWidth < 760 }).addTo(map);
  } catch {
    /* radar is a nice-to-have */
  }
}
addRadarLayer();

// ---------- inputs ----------

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function fillDepartOptions() {
  const now = Date.now();
  const prev = departSelect.value || '0';
  departSelect.innerHTML = DEPART_OFFSETS_MIN.map((m) => {
    const t = clock(now + m * 60_000);
    return `<option value="${m}">${m === 0 ? `Now, ${t}` : `In ${fmtOffset(m)}, ${t}`}</option>`;
  }).join('');
  departSelect.value = prev;
}
fillDepartOptions();

function attachSearch(input: HTMLInputElement, which: 'from' | 'to') {
  const list = $<HTMLUListElement>(`.suggestions[data-for=${which}]`);
  let timer: number | undefined;
  let seq = 0;
  const close = () => (list.innerHTML = '');
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return close();
    timer = window.setTimeout(async () => {
      const mine = ++seq;
      const c = map.getCenter();
      const places = await search(q, { lat: c.lat, lon: c.lng }).catch(() => []);
      if (mine !== seq) return;
      list.innerHTML = '';
      for (const p of places) {
        const li = document.createElement('li');
        li.textContent = p.label;
        li.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          close();
          setPlace(which, p);
          if (!(state.from && state.to)) map.setView([p.point.lat, p.point.lon], 14);
        });
        list.appendChild(li);
      }
    }, 300);
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}
attachSearch(fromInput, 'from');
attachSearch(toInput, 'to');

$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('This browser does not share its location.', 'error');
  setStatus('Finding you…');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      map.setView([p.lat, p.lon], 14);
      setStatus('');
      setPlace('from', await reverse(p));
    },
    (err) => setStatus(`No location: ${err.message}`, 'error'),
    { enableHighAccuracy: true, timeout: 10_000 },
  );
});

$('#swap').addEventListener('click', () => {
  const { from, to } = state;
  setPlace('from', to, { recompute: false });
  setPlace('to', from);
});

document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) =>
  r.addEventListener('change', () => {
    speedInput.value = String(DEFAULT_SPEED_KMH[settings().mode]);
    run();
  }),
);
for (const el of [speedInput, departSelect, thresholdSelect, tauSelect]) el.addEventListener('change', () => run());

const mapStyleSelect = $<HTMLSelectElement>('#map-style');
function applyMapStyle() {
  document.documentElement.dataset.map = mapStyleSelect.value;
}
try {
  mapStyleSelect.value = localStorage.getItem('mapStyle') ?? 'colour';
} catch {
  mapStyleSelect.value = 'colour';
}
applyMapStyle();
mapStyleSelect.addEventListener('change', () => {
  applyMapStyle();
  try {
    localStorage.setItem('mapStyle', mapStyleSelect.value);
  } catch {
    /* storage unavailable */
  }
});

try {
  orsKeyInput.value = localStorage.getItem('orsKey') ?? '';
} catch {
  /* storage unavailable */
}
orsKeyInput.addEventListener('change', () => {
  try {
    localStorage.setItem('orsKey', orsKeyInput.value.trim());
  } catch {
    /* storage unavailable */
  }
  run();
});

$('#plan').addEventListener('submit', (e) => {
  e.preventDefault();
  run();
});

// ---------- compute ----------

let runSeq = 0;

async function run() {
  if (!state.from || !state.to) return setStatus('Pick a start and a destination: search, or click the map.');
  const mine = ++runSeq;
  const s = settings();
  fillDepartOptions();
  try {
    const key = JSON.stringify([state.from.point, state.to.point, s.mode, s.orsKey]);
    const p = state.prepared;
    const maxDistance = p?.key === key ? Math.max(...p.routes.map((r) => r.distance)) : 0;
    const neededUntil = Date.now() / 1000 + (s.departMin + 180) * 60 + maxDistance / (s.speedKmh / 3.6);
    const stale =
      !p || p.key !== key || Date.now() - p.fetchedAt > WEATHER_MAX_AGE_MS || neededUntil > p.weather.coversUntil;
    if (stale) {
      setStatus('Fetching routes and forecasts…');
      const prepared = await prepare(key, state.from.point, state.to.point, s.mode, s.speedKmh, s.orsKey);
      if (mine !== runSeq) return;
      if (state.prepared?.key !== key) state.selected = 0;
      state.prepared = prepared;
    }
    evaluate();
    render();
    const pr = state.prepared!;
    const notes = [pr.warning, pr.weather.ensembles.length === 0 ? 'No ensemble forecast covers this area.' : '']
      .filter(Boolean)
      .join(' ');
    setStatus(notes, notes ? 'warn' : undefined);
  } catch (e) {
    if (mine === runSeq) setStatus(`That didn't work: ${(e as Error).message}`, 'error');
  }
}

async function prepare(
  key: string,
  a: LatLon,
  b: LatLon,
  mode: Mode,
  speedKmh: number,
  orsKey?: string,
): Promise<Prepared> {
  const { routes, warning } = await getRoutes(a, b, mode, orsKey);

  // Weather locations on a ~1 km grid, shared between alternative routes.
  const locs: LatLon[] = [];
  const cellIndex = new Map<string, number>();
  const samples = routes.map((r) => samplePath(r.path, Math.max(250, r.distance / MAX_SAMPLES_PER_ROUTE)));
  const locIdx = samples.map((ss) =>
    ss.map(({ point }) => {
      const cell = `${point.lat.toFixed(2)},${point.lon.toFixed(2)}`;
      if (!cellIndex.has(cell)) {
        cellIndex.set(cell, locs.length);
        locs.push(point);
      }
      return cellIndex.get(cell)!;
    }),
  );

  // Enough forecast for the latest departure option plus the ride at half the chosen speed.
  const longestRideSec = Math.max(...routes.map((r) => r.distance)) / ((speedKmh * 0.5) / 3.6);
  const hours = Math.min(48, Math.ceil((DEPART_OFFSETS_MIN.at(-1)! * 60 + longestRideSec) / 3600) + 2);
  const weather = await fetchWeather(locs, hours);
  if (!weather.deterministic && weather.ensembles.length === 0) throw new Error(weather.failures.join('; '));

  return { key, routes, samples, locIdx, weather, scenarios: ensembleScenarios(weather.ensembles), fetchedAt: Date.now(), warning };
}

function evaluate() {
  const p = state.prepared!;
  const s = settings();
  const now = Math.floor(Date.now() / 1000);
  const departure = now + s.departMin * 60;
  const detRate = p.weather.deterministic ? deterministicRate(p.weather.deterministic) : null;
  const opts: ForecastOptions = {
    thresholdMmH: s.threshold,
    tauSec: s.tauMin * 60,
    highResWeight: HIGH_RES_WEIGHT,
    neighbourhood: NEIGHBOURHOOD,
  };
  state.evals = p.routes.map((_, i) => {
    const ride = buildRide(
      p.samples[i].map((x) => x.distance),
      p.locIdx[i],
      s.speedKmh / 3.6,
    );
    return {
      ride,
      fc: forecastRoute(p.scenarios, detRate, ride, departure, opts),
      det: detRate ? evaluateScenario(detRate, ride, departure) : null,
      scan: departureScan(p.scenarios, detRate, ride, now, DEPART_OFFSETS_MIN, opts),
    };
  });
}

// ---------- render ----------

function setStatus(msg: string, kind?: 'warn' | 'error') {
  statusEl.textContent = msg;
  statusEl.className = `sbb-small ${kind ?? ''}`;
}

const ll = (q: LatLon): L.LatLngTuple => [q.lat, q.lon];
const pct = (p: number) => `${Math.round(p * 100)}%`;
const mm = (x: number) => (x < 0.05 ? '0 mm' : `${x.toFixed(1)} mm`);
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const mins = (sec: number) => `${Math.max(1, Math.round(sec / 60))} min`;
function fmtOffset(m: number) {
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

function verdict(p: number): string {
  if (p < 0.1) return 'Dry';
  if (p < 0.3) return 'Probably dry';
  if (p < 0.55) return 'Take a jacket';
  if (p < 0.8) return 'Likely wet';
  return 'Wet';
}

const priceRow = (name: string, fig: string, cls = '') =>
  `<li class="sbb-price-row ${cls}"><span class="sbb-price-name">${name}</span><span class="sbb-price-dots"></span><span class="sbb-price-fig">${fig}</span></li>`;

function render() {
  resultsEl.hidden = false;
  renderMap();
  renderHero();
  renderRoutes();
  renderScan();
  renderTimeline();
  renderCrossCheck();
}

function renderMap() {
  const p = state.prepared!;
  routeLayer.clearLayers();
  const bounds = L.latLngBounds([]);
  p.routes.forEach((route, i) => {
    if (i === state.selected) return;
    const fc = state.evals[i].fc;
    const line = L.polyline(route.path.map(ll), { color: rgb(palette.ink1), weight: 3, opacity: 0.7, dashArray: '2 7', lineCap: 'square' })
      .on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        selectRoute(i);
      })
      .bindTooltip(`Route ${i + 1}: <b>${fc ? pct(fc.probability) : '–'}</b> chance of rain`)
      .addTo(routeLayer);
    bounds.extend(line.getBounds());
  });

  // Selected route: a dark casing, filled with the expected rain rate as you pass each point, interpolated
  // smoothly between forecast samples.
  const route = p.routes[state.selected];
  const ev = state.evals[state.selected];
  const cum = cumulativeDistances(route.path);
  const total = cum[cum.length - 1];
  const at = p.samples[state.selected].map((x) => x.distance);
  const rates = ev.fc?.sampleRate ?? at.map(() => 0);
  L.polyline(route.path.map(ll), { color: rgb(palette.text), weight: 10, opacity: 1, lineCap: 'square', renderer: routeCanvas }).addTo(
    routeLayer,
  );
  const step = Math.max(10, total / 600);
  for (let d = 0; d < total; d += step) {
    const d1 = Math.min(total, d + step);
    L.polyline(slicePath(route.path, cum, d, d1).map(ll), {
      color: rateColor(interpolate(at, rates, (d + d1) / 2)),
      weight: 6,
      opacity: 1,
      lineCap: 'round',
      interactive: false,
      renderer: routeCanvas,
    }).addTo(routeLayer);
  }

  // One invisible, wide line for hovering: the tooltip reads values at the point under the pointer.
  const tipAt = (d: number) => {
    const offsetSec = interpolate(at, ev.ride.map((r) => r.offsetSec), d);
    const lines = [
      `<b>${km(d)}</b> · ${mins(offsetSec)} in, ${clock(Date.now() + (settings().departMin * 60 + offsetSec) * 1000)}`,
      `Expected rain ${interpolate(at, rates, d).toFixed(1)} mm/h`,
    ];
    if (ev.fc) lines.push(`${pct(interpolate(at, ev.fc.sampleProb, d))} chance it's raining here`);
    return lines.join('<br>');
  };
  const hover = L.polyline(route.path.map(ll), { weight: 20, opacity: 0 })
    .bindTooltip(tipAt(0), { sticky: true })
    .addTo(routeLayer);
  hover.on('mousemove', (e: L.LeafletMouseEvent) =>
    hover.setTooltipContent(tipAt(distanceAlong(route.path, cum, { lat: e.latlng.lat, lon: e.latlng.lng }))),
  );

  renderRateLegend();
  bounds.extend(L.latLngBounds(route.path.map(ll)));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
}

function renderRateLegend() {
  if (!(rateLegend as any)._map) rateLegend.addTo(map);
  const inks = rateInks();
  const gradient = inks.map((c, i) => `${rgb(c)} ${(i / (inks.length - 1)) * 100}%`).join(', ');
  rateLegend.getContainer()!.innerHTML = `
    <span class="sbb-label">Expected rain, mm/h</span>
    <i style="background: linear-gradient(to right, ${gradient})"></i>
    <span class="ticks">${RATE_STOPS.map((r, i) => `<span>${r}${i === RATE_STOPS.length - 1 ? '+' : ''}</span>`).join('')}</span>`;
}

function renderHero() {
  const ev = state.evals[state.selected];
  const route = state.prepared!.routes[state.selected];
  const s = settings();
  const rideSec = route.distance / (s.speedKmh / 3.6);
  const hero = $('#hero');
  if (!ev.fc) {
    hero.innerHTML = `<div class="hero"><p class="sbb-poster">?</p><p class="sbb-pull">No forecast covers this ride.</p></div>`;
    return;
  }
  const { probability, ensemble } = ev.fc;

  // One pen note, for the single most useful change: leave later, or take another route.
  let note = '';
  const best = ev.scan
    .filter((o) => o.result)
    .reduce((a, b) => (b.result!.probability < a.result!.probability - 0.005 ? b : a), ev.scan[0]);
  const driest = state.evals.reduce((a, e, i) => (e.fc && e.fc.probability < state.evals[a].fc!.probability ? i : a), state.selected);
  if (best?.result && best.offsetMin !== s.departMin && best.result.probability < probability - 0.15)
    note = `leave ${best.offsetMin === 0 ? 'now' : `at ${clock(Date.now() + best.offsetMin * 60_000)}`}: ${pct(best.result.probability)}`;
  else if (driest !== state.selected && state.evals[driest].fc!.probability < probability - 0.1)
    note = `route ${driest + 1} is drier: ${pct(state.evals[driest].fc!.probability)}`;

  hero.innerHTML = `
    <div class="hero">
      <div class="hero-top">
        <p class="sbb-poster">${pct(probability)}</p>
        <span class="sbb-tag sbb-tag-tilt">${verdict(probability)}</span>
      </div>
      <p class="sbb-pull">chance of rain on your ${km(route.distance)}, ${mins(rideSec)} ${s.mode === 'cycling' ? 'ride' : 'walk'}</p>
      <ul class="sbb-prices-list">
        ${ensemble ? priceRow('Expected rain on you', mm(ensemble.meanMm)) : ''}
        ${ensemble ? priceRow('Bad case, 1 in 10', mm(ensemble.p90Mm)) : ''}
        ${ev.det ? priceRow('High-res forecast', mm(ev.det.exposureMm)) : ''}
      </ul>
      ${
        note
          ? `<span class="sbb-scrib-note"><svg viewBox="0 0 40 28" aria-hidden="true" class="sbb-scrib-line"><path d="${SCRIBBLE_ARROW}"/></svg><span>${note}</span></span>`
          : ''
      }
    </div>`;
}

function selectRoute(i: number) {
  state.selected = i;
  render();
}

function renderRoutes() {
  const p = state.prepared!;
  const el = $('#routes');
  const s = settings();
  if (p.routes.length < 2) {
    el.innerHTML = `<p class="sbb-small muted">One route, via ${p.routes[0].provider}.</p>`;
    return;
  }
  el.innerHTML = `
    <section>
      <h2>Routes</h2>
      <ul class="routes">${p.routes
        .map((r, i) => {
          const fc = state.evals[i].fc;
          return `<li><button class="route ${i === state.selected ? 'current' : ''}" data-i="${i}">
            <span class="route-no">${String(i + 1).padStart(2, '0')}</span>
            <span class="route-name">${i === 0 ? 'Fastest' : `Alternative`}
              <span class="route-meta">${km(r.distance)} · ${mins(r.distance / (s.speedKmh / 3.6))}</span></span>
            <span class="route-dots"></span>
            <span class="route-fig">${fc ? pct(fc.probability) : '–'}</span>
          </button></li>`;
        })
        .join('')}</ul>
      <p class="sbb-small muted">Via ${p.routes[0].provider}.</p>
    </section>`;
  el.querySelectorAll<HTMLButtonElement>('.route').forEach((b) =>
    b.addEventListener('click', () => selectRoute(Number(b.dataset.i))),
  );
}

function renderScan() {
  const ev = state.evals[state.selected];
  const current = settings().departMin;
  const el = $('#scan');
  el.innerHTML = `<div class="bars">${ev.scan
    .map(({ offsetMin, result }) => {
      const t = clock(Date.now() + offsetMin * 60_000);
      const label = offsetMin === 0 ? 'now' : t;
      if (!result) return `<div class="bar na" title="${t}: beyond the forecast"><em>–</em><i></i><span>${label}</span></div>`;
      const h = Math.max(2, result.probability * 100);
      const mmNote = result.ensemble ? `, about ${mm(result.ensemble.meanMm)}` : '';
      return `<button class="bar ${offsetMin === current ? 'current' : ''}" data-m="${offsetMin}"
        title="Leave ${t}: ${pct(result.probability)} chance${mmNote}">
        <em>${Math.round(result.probability * 100)}</em><i style="height:${h}%"></i><span>${label}</span></button>`;
    })
    .join('')}</div>
    <p class="sbb-small muted note">Chance of rain (%) by departure time. Tap a bar to plan for it.</p>`;
  el.querySelectorAll<HTMLButtonElement>('button.bar').forEach((b) =>
    b.addEventListener('click', () => {
      departSelect.value = b.dataset.m!;
      run();
    }),
  );
}

function renderTimeline() {
  const ev = state.evals[state.selected];
  const el = $('#timeline');
  const W = 600;
  const H = 150;
  const pad = { l: 34, r: 40, t: 10, b: 24 };
  const n = ev.ride.length;
  const totalMin = ev.ride[n - 1].offsetSec / 60 || 1;
  const x = (min: number) => pad.l + (min / totalMin) * (W - pad.l - pad.r);
  const rates = ev.fc?.sampleRate ?? [];
  const maxRate = Math.max(1, ...rates);
  const yRate = (r: number) => H - pad.b - (r / maxRate) * (H - pad.t - pad.b);
  const yProb = (p: number) => H - pad.b - p * (H - pad.t - pad.b);
  const barW = Math.max(2, (W - pad.l - pad.r) / n - 1);

  const bars = rates
    .map((r, j) => {
      const cx = x(ev.ride[j].offsetSec / 60);
      return `<rect x="${cx - barW / 2}" y="${yRate(r)}" width="${barW}" height="${H - pad.b - yRate(r)}" class="rate"><title>${r.toFixed(1)} mm/h</title></rect>`;
    })
    .join('');
  const probLine = ev.fc
    ? `<polyline class="prob" points="${ev.fc.sampleProb.map((p, j) => `${x(ev.ride[j].offsetSec / 60)},${yProb(p)}`).join(' ')}"/>`
    : '';
  const ticks = [0, 0.5, 1].map((f) => {
    const m = f * totalMin;
    return `<text x="${x(m)}" y="${H - 6}" text-anchor="middle">${Math.round(m)} min</text>`;
  });

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Rain along the ride">
      <line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}" class="axis"/>
      ${bars}${probLine}
      ${ticks.join('')}
      <text x="${pad.l - 6}" y="${pad.t + 8}" text-anchor="end">${maxRate.toFixed(1)}</text>
      <text x="${pad.l - 6}" y="${H - pad.b}" text-anchor="end">0</text>
      <text x="${W - pad.r + 6}" y="${pad.t + 8}">100%</text>
      <text x="${W - pad.r + 6}" y="${H - pad.b}">0%</text>
    </svg>
    <div class="legend sbb-small"><span><i></i>Expected rain, mm/h</span><span><i class="line"></i>Chance it's raining where you are</span></div>`;
}

function renderCrossCheck() {
  const p = state.prepared!;
  const ev = state.evals[state.selected];
  const el = $('#crosscheck');
  if (!ev.fc) {
    el.innerHTML = '';
    return;
  }
  const { ensemble, ensembleCrossCheck: cc, highRes } = ev.fc;
  const tau = settings().tauMin;
  const rows = [
    priceRow('Headline', pct(ev.fc.probability), 'strong'),
    ensemble ? priceRow(`Ensembles, ${ensemble.members} futures followed`, pct(ensemble.probability)) : '',
    highRes ? priceRow('High-res, 15 min, neighbourhood', pct(highRes.probability)) : '',
  ].join('');
  const bounds = cc
    ? [
        priceRow('All one rain system', pct(cc.fullyCorrelated)),
        priceRow(`Correlated over ${tau} min`, pct(cc.markov)),
        priceRow('Every point independent', pct(cc.independent)),
      ].join('')
    : '';
  const models = (ensemble?.byModel ?? [])
    .map((m) => `<tr><td>${m.model}</td><td>${m.members}</td><td>${pct(m.probability)}</td><td>${mm(m.meanMm)}</td></tr>`)
    .join('');
  const failed = p.weather.failures.length
    ? `<p class="sbb-small muted note">Not available here: ${p.weather.failures.map((f) => f.split(':')[0]).join(', ')}.</p>`
    : '';

  el.innerHTML = `
    <ul class="sbb-prices-list">${rows}</ul>
    <p class="sbb-small muted note">The headline is ${Math.round((1 - HIGH_RES_WEIGHT) * 100)}% ensembles, ${Math.round(HIGH_RES_WEIGHT * 100)}% high-res.
      Each ensemble member is one plausible future: we follow you through it and count the futures where you meet rain.
      The high-res forecast is a single 2 km run at 15-minute steps; it is read as a probability from the share of wet
      places within 2 km and 30 min of you, then combined along the route as below.</p>
    ${
      bounds
        ? `<p class="sbb-label sub-head">Same per-point chances, combined three ways</p>
      <ul class="sbb-prices-list">${bounds}</ul>
      <p class="sbb-small muted note">The per-point chances alone don't fix the route chance; that depends on how rain at one
      point relates to the next. Fully correlated and fully independent are the two limits. The middle row treats the
      rain you ride through as staying similar for about ${tau} minutes (change it in settings). Ensembles get the
      correlation from the weather model itself, which is why the headline leans on them.</p>`
        : ''
    }
    ${
      models
        ? `<p class="sbb-label sub-head">Ensemble models</p>
      <table><thead><tr><th class="sbb-label">Model</th><th class="sbb-label">Futures</th><th class="sbb-label">Rain</th><th class="sbb-label">Mean</th></tr></thead><tbody>${models}</tbody></table>`
        : ''
    }
    ${failed}`;
}

setStatus('Pick a start and a destination: search, or click the map.');
