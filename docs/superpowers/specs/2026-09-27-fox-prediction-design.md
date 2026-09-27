# Fox Prediction — Design

Date: 2026-09-27
Status: approved (brainstorm), pending implementation plan
Repos: `jotihunt-tracker-server` (branch `feat/fox-prediction`) + `jotihunt-tracker-client` (branch `feat/fox-prediction`, stacked on `feat/shadcn-new-york`)

## Goal

Per fox team (deelgebied), predict (1) where the team is now — a zone that grows with time since the last
sighting — and (2) the 1–3 most likely next groups it will visit, with an estimated arrival time. The model
learns live during the hunt from new observations, and accounts for public transport (bus/train) that every
fox team may use.

## Game facts the model relies on

Sources: jotihunt.nl/page/spelregels, /page/faq, `docs/02-game-rules.md`.

- Each fox team gets a list of groups it must visit ("alle aan hen gekoppelde groepen"). In this app a group's
  fox team is the group's `Team.area` (lowercase area name).
- A second round may only start after all groups are visited (carries over between halves). The last group of
  round 1 may be the first of round 2, at least 30 min later.
- Order is not prescribed; foxes move "zo strategisch mogelijk".
- Foxes walk (~4–5 km/h). With a travel budget they may use bike, public transport, boat or car; during such a
  move the status is `orange` ("onderweg"). `red` = inactive (not huntable), incl. the swap 22:45–23:15. The new
  team starts near the old team's end point.
- Foxes report their location hourly; that becomes the hint (RD coordinate) → hint markers in this app.
- Team Oscar travelled by public transport in 2025.

## Inputs (existing data)

- `Team` (server model): `apiId`, `name`, `area`, `location` (GeoJSON point). Groups of a fox team = teams with
  `area === <area>`.
- `Marker`: `type` `hint` | `hunt` | `spot`, `area`, `time`, `location`. All three are observations
  `{ area, time, lng, lat, kind }`. Hint markers are the hourly reports; hunt/spot markers are placed by users.
- `Area`: `name`, `status` (`green` | `orange` | `red`), `updatedAt`.

## Part 1 — Walking prediction (server)

### Visit state

New collection `GroupVisit`: `{ area, teamApiId, round, state: 'visited' | 'not_visited', source: 'auto' | 'manual', visitedAt?, evidence? }`,
unique on `{ teamApiId, round }`.

- Auto: a group becomes `visited` (source `auto`) when an observation lies within **300 m** of the group
  location, or when the ORS walking route between two consecutive observations of that area passes within
  **300 m** of it (visitedAt = interpolated time).
- Manual: `PUT /visits/:teamApiId` with `state: 'visited' | 'not_visited' | 'auto'` sets a manual override or
  clears it (`auto` = back to automatic). Manual always wins over auto.
- Rounds: when all groups of an area are visited in round N, round N+1 starts with everything not visited; the
  group visited last in round N is excluded as a candidate until 30 min after its visitedAt.

### Team state and candidates

Recomputed per area on: a new observation for the area, an area status change, and every 5 minutes.

- Last known position/time = newest observation of the area. Heading = bearing between the last two
  observations if they are ≥ 200 m apart and ≤ 3 h apart, else none.
- Candidates = groups of the area that are not visited in the current round (and not excluded by the 30-min rule).
- Travel time per candidate from the last position: ORS foot-walking (see "Routing"), divided by the team's
  learned `speedFactor`; in public-transport mode the minimum of walking and public-transport time (Part 2).
- Score per candidate (higher = more likely), all terms normalised to 0–1:
  - `wTime · (1 − travelMinutes / maxTravelMinutesOfCandidates)`
  - `wHeading · max(0, cos(angle between heading and bearing to candidate))` (0 when no heading)
  - `wTour · [candidate is the first stop of the shortest open tour through all candidates]` — tour from the
    last position by nearest-neighbour + 2-opt on the cached group-to-group matrix
  - `wCluster · (candidates within 1.5 km of it / total candidates)`
- Probabilities = softmax(score / temperature 0.15). Top 3 are published.
- ETA = lastObservationTime + dwellMinutes + travelMinutes. If that ETA is already in the past, the candidate is
  flagged `overdue: true` and shown as "had er al kunnen zijn" (no new ETA is extrapolated).

### Where-are-they-now zone

- Elapsed = now − lastObservationTime − dwellMinutes (≥ 0), capped at 120 min.
- Outer zone = ORS foot-walking isochrone from the last position with range `elapsed · speedFactor`.
  Core zone = isochrone with half that range. Both as GeoJSON polygons.
- Status `red`: no zone, no ETAs — prediction paused ("Inactief, voorspelling gepauzeerd").
- No observations yet: "Nog geen waarnemingen".

### Live learning (per area, stored in `PredictionModel`)

Parameters and start values: `speedFactor = 1.0` (relative to ORS foot speed ≈ 5 km/h; clamp 0.5–1.6),
`dwellMinutes = 15` (clamp 0–45), weights `wTime 1.0, wHeading 0.5, wTour 0.7, wCluster 0.3` (each clamp 0–2).

On every new hint observation for the area:
1. Take the prediction snapshot that was current just before the observation.
2. Determine the "actual" group = the group the team was heading to: the first group that becomes visited after
   the snapshot (resolved lazily: evaluate when the next visit is detected).
3. Accuracy counters: `top1Hits`, `top3Hits`, `evaluations`.
4. Updates with exponential moving average (α = 0.3):
   - `speedFactor ← EMA(observed ORS-route distance between the last two observations / (Δt − dwell) / ORS speed)`
   - `dwellMinutes ← EMA(time between a visit's detection and the next observation leaving the 300 m radius)`
     when both are known.
   - Weights: for each term, `w ← w + 0.1 · (term(actual) − Σ p_i · term(candidate_i))` (one step of gradient
     ascent on the log-likelihood of the actual group), then clamp.

### Routing (OpenRouteService)

- `ORS_API_KEY` in `.env`. Profile `foot-walking`.
- Group-to-group matrix per area: `POST /v2/matrix/foot-walking` (durations + distances), cached in
  `RoutingCache` keyed by area + sorted group ids; recomputed only when an area's group set changes.
- From-position matrix (last position → candidates): one matrix call per recompute that has a new position.
- Route between consecutive observations (for visit detection): `POST /v2/directions/foot-walking/geojson`.
- Isochrones: `POST /v2/isochrones/foot-walking` with two ranges (core, outer) in one call.
- Throttle: ≤ 1 request/s globally; per-day counters; a new position triggers calls, the 5-minute tick reuses
  cached results and only recomputes elapsed-dependent values.
- Fallback when no key / HTTP error / quota: straight-line distance × 1.3 at 5 km/h, circle zones
  (turf), visit detection by straight segment; the prediction is marked `estimate: true` → UI shows "(schatting)".

## Part 2 — Public transport (Transitous)

- Stops: once (and via an admin action to refresh), fetch railway stations and bus/tram stops within the
  bounding box of all groups + 10 km from the Overpass API (`node[public_transport=platform]`,
  `node[railway=station]`, `node[highway=bus_stop]`), store in `TransitStop` `{ name, kind, location }`.
- Public-transport mode for an area when any of:
  - the last observation is < 250 m from a stop,
  - the area status is `orange`,
  - the area is `oscar` (always).
- In public-transport mode, per candidate: Transitous `GET https://api.transitous.org/api/v5/plan` from the last
  position to the group at the time of the last observation (+ dwell). Travel time = min(walking, transit
  itinerary duration). Candidate shows the mode used ("🚆 trein/bus" label + line number from the itinerary).
- Zone in public-transport mode: the walking zone plus "islands": for each stop reached by the fetched
  itineraries where (arrival time ≤ now), a walking isochrone from that stop with the remaining time
  (max 3 islands, largest remaining time first).
- Requests carry `User-Agent: jotihunt-tracker (+https://github.com/SilkePilon/jotihunt-tracker-server)`
  and no personal data; ≤ 1 request/s; cache results per (area, last observation, candidate) for 30 min.
- Transitous unreachable → walking only, prediction flagged `transitUnavailable: true` → UI warning.

## API (server)

- `GET /predictions` (auth) →
  `[{ area, status, mode: 'walking' | 'transit', estimate, transitUnavailable, lastObservation: { time, lng, lat, kind } | null,
     zone: { core: Polygon | null, outer: Polygon | null, islands: Polygon[] }, candidates: [{ teamApiId, name, probability, travelMinutes, eta, via: 'walk' | 'transit', transitLabel? , overdue }],
     accuracy: { top1Hits, top3Hits, evaluations }, updatedAt, paused: boolean, reason? }]`
- `GET /visits` (auth) → `GroupVisit[]` for current rounds.
- `PUT /visits/:teamApiId` (auth) `{ state: 'visited' | 'not_visited' | 'auto' }` → updated visit, triggers recompute of that area.
- `POST /admin/transit-stops/refresh` (admin) → re-fetch stops.

## Client

- Map layer "Voorspelling" (toggle in Zichtbare lagen, default on): per area the core zone (area colour, 35 %
  opacity) and outer zone (15 %), islands (dashed outline), lines from the last position to the top-3
  candidates with a label `62% · ~14:20` (`🚆` prefix when via transit). Estimate zones get a dashed border.
- Groups (existing Teams layer): a small check badge when visited; the group popup gets
  "Bezocht / Niet bezocht / Automatisch" buttons (current state highlighted, manual vs auto shown).
- Sidebar section "Voorspelling" (between Hints and Hint registreren): per area one row —
  area dot + name, top-1 group + probability + ETA, mode icon, accuracy `top-3 7/9`, status text when paused /
  no observations. Clicking a row flies the map to the zone. Collapsed summary: number of active predictions.
- Polling `GET /predictions` and `GET /visits` every 15 s via the existing SWR helper.
- UI copy Dutch.

## Error handling

- ORS / Transitous / Overpass failures never break `/predictions`; they degrade to estimates with flags.
- A recompute error for one area is logged and leaves that area's previous prediction in place (with its
  `updatedAt`), other areas continue.

## Testing

Server (`bun test`, no network — routing clients are injected and mocked):
- scoring + softmax, tour (nearest-neighbour + 2-opt) on a small matrix, heading term, cluster term;
- visit detection (point radius, route-segment distance), manual override precedence, round rollover + 30-min rule;
- learning updates (EMA, weight step, clamps) with hand-computed expectations;
- public-transport mode triggers; min(walk, transit) choice; island selection;
- fallback maths (straight line × 1.3, circle zones);
- replay test: a synthetic area with 8 groups and a scripted fox route of hourly hints; after 3 hints the top-3
  contains the true next group in ≥ 70 % of the remaining hours.
Client: build + lint; screenshots of the layer, sidebar section and group popup with seeded observations.
