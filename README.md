# Will I get wet?

Weather-aware cycle (and walking) routing. Pick A and B and it tells you the **chance you'll get rained on**
during the journey, how much rain to expect, which route is driest, and whether leaving a bit later would
keep you dry.

Runs entirely in the browser on free, keyless APIs. There's no backend.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests for the rain maths
npm run build    # static site in dist/ (GitHub Pages / Cloudflare Pages / Netlify)
```

## How it works

1. **Route.** [FOSSGIS OSRM](https://routing.openstreetmap.de/) bike/foot profiles (no key, gives
   alternatives). Add a free [openrouteservice](https://openrouteservice.org/dev/#/signup) key under
   *Settings* to use its cycling profile instead. If routing fails it falls back to a straight line.
2. **Sample.** Each route gets up to 40 evenly spaced points. With your speed, each point gets an ETA.
3. **Forecast.** [Open-Meteo](https://open-meteo.com/) precipitation for those points:
   - **Ensembles** (many equally plausible futures). Each model is queried only as densely as its grid
     resolution, and models that don't cover the route drop out, so the same setup works for any city:

     | Model | Res. | Members | Weight | Coverage |
     |---|---|---|---|---|
     | DWD ICON-D2 EPS | 2 km | 20 | 4 | Central/W Europe incl. London |
     | Met Office MOGREPS-UK | 2 km | 3 | 2 | UK |
     | DWD ICON-EU EPS | 13 km | 40 | 2 | Europe |
     | Met Office MOGREPS-G | 20 km | 18 | 1 | Global |
     | ECMWF IFS ENS | 25 km | 51 | 1 | Global |
     | NOAA GEFS | 25 km | 31 | 1 | Global |

   - **High-res deterministic** (`best_match`, 15-minute steps; the Met Office UKV 2 km in the UK). This is
     used for the "along the ride" chart and the high-res mm estimate.
4. **Ensemble estimate.** For every ensemble member we follow you along the route through *that
   member's* forecast, reading the rain rate where you are at the moment you're there. A member counts as
   wet if you meet rain ≥ the threshold (default 0.2 mm/h) anywhere on the ride; its rain total is
   Σ rate × time spent. Chance of rain = weighted share of wet members (each model's weight is split
   across its members, so the 51-member ECMWF doesn't drown out the 2 km models). Each member is
   coherent in space and time, so this gets the correlation between points from the weather model.
5. **High-res estimate.** The 15-minute deterministic forecast is turned into per-point chances with a
   *neighbourhood*: the share of wet forecast values within ±2 km along the route and ±30 min of your
   ETA (high-res models get showers right but misplace them a little). Those are then combined along
   the route with the Markov model below.
6. **Headline** = 70% ensemble + 30% high-res (`HIGH_RES_WEIGHT` in `src/main.ts`). Uncalibrated for
   now; see next steps.
7. **Leave later?** Everything is re-evaluated for departures every 15 min over the next 3 h at no
   extra API cost. Alternative routes are scored the same way.

### Combining per-point chances

Per-point chances pᵢ ("is it raining where I am, then?") don't determine the route chance; that needs
the joint distribution. They bound it:

    max pᵢ  ≤  P(wet)  ≤  1 − Π(1 − pᵢ)
    (one rain system)     (independent; grows with sampling density)

In between, the app models "raining where I am" as a two-state Markov process with correlation time τ
(Settings, default 20 min). Between samples the joint dry probability keeps the marginals and has
correlation ρ = exp(−Δt/τ), which in the continuous limit is the hazard integral

    P(dry all the way) = (1 − p₀) · exp(−∫ p(t)/τ dt)

and so doesn't depend on how finely the route is sampled. "How the number is made" in the UI shows the
ensemble and high-res estimates, plus the ensemble's per-point chances combined all three ways.

## Design

Styled with [small bean behaviour](https://github.com/jbremz/small-bean-behaviour), vendored in
`src/design/`. It uses the `cobalt-tomato` pairing (cobalt = rain) and its night twin. The map tiles
are printed in ink-1 via an SVG filter (`#map-duotone` in `index.html`): a duotone base plus extra
plates for water (strong) and parks (light tint). Ink-2 is reserved for rain: the radar overlay. Route ink coverage shows the
chance of rain: bare paper means dry, solid cobalt means wet.

The pure maths lives in `src/rainModel.ts` (tested in `tests/`). Network code is in `src/weather.ts`,
`src/routing.ts` and `src/geocode.ts`. The UI is `src/main.ts` (Leaflet + plain DOM).

## Known limitations

- Ensemble data is **hourly**. A 10-minute ride inside a "1 mm in this hour" hour is treated as steady
  light rain, when in reality it may be a 5-minute downpour you could miss. The 15-min high-res forecast
  helps here but isn't probabilistic.
- No radar nowcast (extrapolated radar is the best predictor for the next ~1–2 h). The RainViewer
  overlay is the latest observed frame only.
- ETAs assume a constant speed (no hills, lights or junctions).
- Open-Meteo's free tier is for non-commercial use and rate-limited per minute (each location counts).

## Ideas / next steps

- **Nowcasting**: blend in radar extrapolation for the first 1–2 h (e.g. Met Office DataHub, free
  tier with key; or optical-flow on RainViewer frames). This would give the biggest accuracy gain for
  short London rides.
- **Dodge the shower routing**: route through waypoints that avoid forecast cells (generate candidate
  detours, score with `evaluateEnsemble`), and re-plan en route with live GPS.
- Per-segment speeds from the router, elevation-aware speed.
- Notifications: "rain arriving on your commute in 20 min".
- Calibrate the threshold/weights against observed radar.
