import type { AreaFacts } from "./facts";

const CLOCK = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "14:05" in Dutch local time. */
export function clock(date: Date): string {
  return CLOCK.format(date);
}

const RULES = `You predict where a fox team is in Jotihunt, a Dutch scouting game.
Rules:
- The fox team (one per area) walks, about 4-5 km/h. Walking minutes to each group are measured along real paths (walkMinutes, from the last trail point).
- The foxes must visit every group of their area once per round, in an order they choose. They usually stay 5-20 minutes at a group.
- A new round starts only after every group was visited. The last group of a round may only be the first of the next round 30 minutes later.
- Status: green = walking, huntable. orange = travelling with a movement budget (car/transit possible, faster than walking). red = inactive.
- At 23:00 the fox teams swap; everyone is inactive 22:45-23:15, and the new team starts near where the old team ended.
- After handing out a counter-hunt code, a fox may not be hunted for 5 minutes.
- The trail: kind "hint" = the solved hourly coordinate (where they were at that time), "hunt" = hunters caught them there, "spot" = hunters saw them there. Newer points are more important.
- manualVisits are confirmed by humans and always correct.

Task:
1. Decide which groups were already visited in the current round (from the trail passing close to them, and manualVisits).
2. Decide the round (the current one, or the next if every group was visited).
3. Estimate where the foxes are right now (pin), taking elapsed time since the last trail point, walking speed and likely stops into account.
4. confidence: high when a trail point is recent and the direction is clear, low when the last point is old or ambiguous.
5. reason: one short Dutch sentence, at most 15 words.
Answer only with the JSON object.`;

export const PREDICTION_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    round: { type: "INTEGER" },
    visitedTeamApiIds: { type: "ARRAY", items: { type: "INTEGER" } },
    pin: { type: "OBJECT", properties: { lat: { type: "NUMBER" }, lng: { type: "NUMBER" } }, required: ["lat", "lng"] },
    confidence: { type: "STRING", enum: ["low", "medium", "high"] },
    reason: { type: "STRING" },
  },
  required: ["round", "visitedTeamApiIds", "pin", "confidence", "reason"],
};

export function buildPrompt(facts: AreaFacts): string {
  const data = {
    area: facts.area,
    status: facts.status,
    now: clock(facts.now),
    round: facts.round,
    trail: facts.trail.map((point) => ({
      time: clock(point.time),
      minutesAgo: Math.round((facts.now.getTime() - point.time.getTime()) / 60_000),
      kind: point.kind,
      lat: point.lat,
      lng: point.lng,
    })),
    groups: facts.groups.map((group) => ({ teamApiId: group.teamApiId, name: group.name, lat: group.lat, lng: group.lng, walkMinutes: group.walkMinutes })),
    manualVisits: facts.manualVisits,
  };
  return `${RULES}\n\nFacts:\n${JSON.stringify(data)}`;
}
