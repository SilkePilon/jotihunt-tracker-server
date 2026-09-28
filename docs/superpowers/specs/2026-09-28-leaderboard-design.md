# Leaderboard — Design

Date: 2026-09-28
Status: approved (brainstorm; layout "1 · Klassiek podium" picked in the visual companion)
Repos: server + client, branch `feat/leaderboard` in both (from `main`).

## Goal

A fun leaderboard of all hunters (app users), opened from a "Leaderboard" button below "Alle hunts bekijken" in the
sidebar Hunts card: a 2-1-3 podium for the top 3, a team stats strip and a list for everyone else.

## Score (per user)

- +2 per hunt report the user registered (`HuntReport.reportedBy`, kinds hunt and tegenhunt).
- + the jotihunt.nl points of those reports once judged (`HuntReport.site.points`).
- +3 per hint cell the user solved (`HintCell.status === "solved"` and `claimedBy === user`).
- +1 per full 5 km their own tracker (`User.tracker.deviceId`) travelled in the distance window (Traccar summary
  report, `distance` in metres).
- Rank: score descending; equal scores share a place (1, 2, 2, 4). Order within a tie: more hunts first, then name.

## Distance window

- `HUNT_START_TIME` … min(now, `HUNT_END_TIME`) when now ≥ `HUNT_START_TIME`.
- Otherwise (before the hunt, or `HUNT_START_TIME` missing/invalid): start of today (Europe/Amsterdam server TZ) … now,
  so the leaderboard can be tried before the weekend. The response says which window was used.

## Server

- `GET /leaderboard` (auth, every user) →
  ```
  {
    entries: [{ userId, name, rank, score, hunts, approvedHunts, huntPoints, hints, distanceKm, topSpeedKmh | null,
                breakdown: { hunts, huntPoints, hints, distance } }],
    totals: { distanceKm, hunts, hints, fastest: { name, speedKmh } | null },
    distanceSince: ISO, distanceWindow: "hunt" | "today",
    distanceAvailable: boolean,   // false when Traccar is not configured or failed
    updatedAt: ISO
  }
  ```
  `approvedHunts` = reports with `site.points > 0`. Names only, never emails.
- Traccar: new `TraccarApi.getSummary(deviceId, from, to) → { distance, maxSpeed } | null` (`/api/reports/summary`,
  JSON; `maxSpeed` in knots → km/h). One call per linked device (few users), all in parallel; any failure → that
  device's distance 0 and `distanceAvailable: false`.
- The whole response is cached in memory for 60 s.
- Scoring is a pure function `buildLeaderboard(users, reports, solvedCells, distances, window, now)` with unit tests.

## Client

- `HuntsSection`: a "Leaderboard" button (trophy icon, variant outline) directly below "Alle hunts bekijken".
- `LeaderboardDialog`: dialog on desktop, drawer on phones (shared responsive frame, the former `AdminShell`, moved to
  `src/components/ResponsiveDialog.tsx`). Title "Leaderboard", description "Wie heeft dit weekend het meest
  bijgedragen?".
  - Podium 2-1-3: avatar with initials (first letters of the name, max 2), crown on #1, name, score, blocks of
    different heights with the rank; #1 in the primary (orange) tint, #2 grey, #3 bronze tint. Fewer than 3 users →
    empty places are not drawn.
  - Team strip: "Samen: 312 km · 18 hunts · 44 hints · snelste: Admin 92 km/u" (parts without data are left out).
  - List from place 4: rank, avatar, name, badges (🎯 hunts, 🧩 hints, 🛣 km), score; the current user's row
    highlighted in orange tint with "(jij)". Clicking a podium spot or a row toggles the score breakdown
    ("Hunts 6 × 2 = 12 · Punten jotihunt.nl 40 · Hints 11 × 3 = 33 · 84 km = 16").
  - Footer note: "Kilometers sinds 17 okt 10:00" or "Kilometers van vandaag (de hunt is nog niet begonnen)";
    "Kilometers tijdelijk niet beschikbaar" when `distanceAvailable` is false.
- SWR poll every 60 s; the dialog only fetches while open.
- UI copy Dutch.

## Testing

Server (`bun test`): scoring (each component, ties share rank, tie order, user without tracker, judged points),
window selection (before/during/after the hunt, missing env), Traccar failure → `distanceAvailable: false`,
getSummary request/parse. Client: helpers (initials, breakdown text, footer text) with `bun test`; build + lint;
screenshots desktop + mobile with seeded data.
