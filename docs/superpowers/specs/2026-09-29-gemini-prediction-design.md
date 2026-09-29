# Gemini fox prediction: design

Date: 2026-09-29. Replaces `2026-09-27-fox-prediction-design.md`.

## Goal

Replace the deterministic fox prediction (scoring, tour planner, learning, zones, transit) with Gemini. The server gathers hard facts and Gemini makes the prediction. The UI shows the result with as little text as possible.

## Decisions

| Topic | Choice |
|---|---|
| Who predicts | Gemini. The server only gathers facts. |
| Extra inputs | ORS walking minutes from the last position to every group. No transit, no unsolved hint text, no feedback from past predictions. |
| Visited groups | Gemini infers them from the trail. Manual Bezocht / Niet bezocht overrides are passed as hard facts. The automatic 300 m detection is removed. |
| Output | One best-guess pin, plus the top 3 groups with probability and ETA. No zone polygons. |
| Trigger | When the inputs change (new marker, status, manual visit), or 10 minutes after the last prediction. Red status = paused, no call. |
| Model | `GEMINI_PREDICTION_MODEL`, default `gemini-pro-latest`. |
| Reasoning | One Dutch sentence of at most 15 words, hidden behind an ⓘ icon. |

## Server

### Removed

- `services/prediction/`: `scoring`, `tour`, `learning`, `zones`, `transit`, `transitous.client`, `overpass.client`, `transit-stop.service`, `visits` (automatic detection) and `replay`, together with their tests.
- Models `PredictionModel` and `TransitStop`. Route `POST /admin/transit-stops/refresh`.
- Transit stops in the demo world generator.

### Kept

- `geo.ts`, `types.ts` (trimmed), `constants.ts`, `http.ts`.
- `ors.client.ts`, `routing-cache.ts`, `straight-line.router.ts` and `routing.ts`, but only for the walking matrix.
- `GroupVisit`, now only for manual overrides (`source: "manual"`). Existing automatic docs are deleted once on startup.
- `GET /predictions`, `GET /visits`, `PUT /visits/:teamApiId`. `auto` removes the manual override.

### New units

1. **`facts.ts`: `gatherFacts(area, now)`**. Pure data assembly from the DB plus the router. Returns:
   - `area`, `status`, `now` (ISO, Europe/Amsterdam).
   - `trail`: every marker of the area, sorted by time: `{time, kind, lat, lng}`.
   - `groups`: every team in the area: `{teamApiId, name, lat, lng, walkMinutes}`. `walkMinutes` is measured from the last trail point, via the ORS matrix with straight-line fallback. `estimate=true` when the fallback was used.
   - `manualVisits`: `{teamApiId, state}`.
   - `signature`: a hash of the status, the marker ids and times, and the manual visits.
2. **`prompt.ts`: `buildPrompt(facts)`**. The game rules in short English (walking 4–5 km/h, rounds, the 30-minute rule, the team swap at 23:00, the tegenhunt pause, orange = travelling with verplaatsingsbudget), the facts as JSON, and the instruction. Pure function.
3. **`gemini-predictor.ts`: `predict(facts)`**. Calls Gemini with `responseMimeType: application/json` and a `responseSchema`, temperature 0.2, timeout 90 s. Reuses the `GeminiHttp` / `GeminiError` pattern from `gemini.client.ts`. The expected output:
   ```json
   {
     "visitedTeamApiIds": [1, 2],
     "pin": {"lat": 52.0, "lng": 5.9},
     "confidence": "low" | "medium" | "high",
     "candidates": [{"teamApiId": 3, "probability": 0.6, "eta": "14:20"}],
     "reason": "Loopt noordwaarts langs de Rijn, Valken ligt op route."
   }
   ```
4. **`validate.ts`: `validatePrediction(raw, facts)`**. Pure function. It:
   - drops candidate ids that do not belong to the area, and visited ids;
   - keeps at most 3 candidates and normalises their probabilities to a sum of 1;
   - turns the ETA "HH:MM" into an ISO time on the correct day (after `now`, rolling over past midnight);
   - rejects a pin more than 15 km from the last trail point;
   - truncates the reason to 120 characters.

   It throws when nothing usable is left.
5. **`prediction.service.ts`: `recomputeDue(now)` / `recomputeArea(area)`**:
   - Red status: store `paused` without a call.
   - No trail: store a `reason` of "nog geen locatie" without a call.
   - Otherwise gather the facts, predict, validate and store. On failure, retry once. If that also fails, keep the last prediction and set `stale=true` and `error`.
   - At most one Gemini call at a time. The cron runs every minute, but only areas that are due are called.

### Prediction document (`Prediction` model)

`area, status, paused, reason?, updatedAt, signature, stale, error?, estimate, lastObservation{time,lng,lat,kind}, pin{lat,lng}|null, confidence, candidates[{teamApiId,name,lng,lat,probability,eta,walkMinutes}], visitedTeamApiIds[], why`.

`GET /predictions` returns everything except `signature`.

## Client

- **`types/Prediction.ts`**: matches the document above. Zone, mode, transit and accuracy are removed.
- **Sidebar `PredictionList` becomes a card per area**:
  - A stripe in the area colour.
  - The area name and a confidence dot (red / orange / green).
  - The age ("2m"). It turns grey with a warning icon when `stale`.
  - An ⓘ popover that shows `why`.
  - Three rows, each with the group name, a % bar and an ETA chip.
  - Tapping the card flies the map to the pin.
  - A paused area shows a single muted "gepauzeerd" line.
- **Map layer `Predictions.tsx`**:
  - A pulsing fox pin in the area colour at `pin`.
  - A dashed line from `lastObservation` to the pin.
  - The top 3 groups get a ring and a badge "62% 14:20".
  - The zone fills are removed.
  - Groups in `visitedTeamApiIds` are dimmed.
- **`VisitControls`**: unchanged buttons (Bezocht / Niet bezocht / Auto = remove the override).
- **`HuntRegistrationDialog`**: the nearest area is based on the pin, with the last observation as fallback.

## Error handling

- No `GEMINI_API_KEY`: log a warning at startup, and every prediction gets `reason` "AI niet geconfigureerd".
- A Gemini 429 or 5xx is retryable. The next cron tick tries again, with a backoff of at least 2 minutes per area.
- Invalid JSON or a failed validation: retry once, then mark stale.

## Testing (bun test)

- `facts.test.ts`: trail order, walk minutes with the router mocked, the fallback `estimate` flag, and the signature changing on relevant changes only.
- `prompt.test.ts`: the rules and the facts appear in the prompt, snapshot-free (contains checks).
- `validate.test.ts`: unknown ids, visited ids, normalisation, the ETA crossing midnight, a pin too far away, empty output.
- `gemini-predictor.test.ts`: http mocked; request shape, error mapping, key never in the message.
- `prediction.service.test.ts`: paused, no trail, due logic (signature or 10 min), retry, stale, one call at a time.
- Client: `lib/prediction.ts` GeoJSON builder tests updated.
