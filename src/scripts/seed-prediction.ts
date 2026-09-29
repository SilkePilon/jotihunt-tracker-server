import mongoose from "mongoose";
import { Area } from "../models/area.model";
import { GroupVisit } from "../models/group-visit.model";
import { Marker, MarkerType } from "../models/marker.model";
import { Prediction } from "../models/prediction.model";
import { RoutingCache } from "../models/routing-cache.model";
import { Team } from "../models/team.model";
import { moveM } from "../services/prediction/geo";
import { predictionService } from "../services/prediction/instance";
import { listPredictions } from "../services/prediction/prediction.service";
import type { LngLat } from "../services/prediction/types";

// Seeds synthetic fox-prediction data so the feature can be tried before the hunt:
// 8 alpha groups (apiId 990000+) with 3 hourly hints and 4 oscar groups (apiId 990100+) with 2 spots.
// Remove with: bun run seed-prediction --clean
// The Docker image sets NODE_ENV=production, so inside the container pass --force:
//   docker compose exec server bun run seed-prediction --force [--clean]
if (process.env.NODE_ENV === "production" && !process.argv.includes("--force")) {
  console.error("Refusing to seed fox prediction data with NODE_ENV=production. Pass --force to override.");
  process.exit(1);
}

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("MONGO_URI is not set");
  process.exit(1);
}
await mongoose.connect(uri);

const ALPHA_START: LngLat = [5.46, 52.08];
const ALPHA_GROUPS = [0, 120, -80, 100, -100, 60, -60, 0].map((northM, index) => moveM(ALPHA_START, 2000 * (index + 1), northM));
const ALPHA_HINTS: LngLat[] = [ALPHA_START, moveM(ALPHA_START, 2400, 60), moveM(ALPHA_START, 5600, -60)];
const OSCAR_GROUPS: LngLat[] = [
  [5.39, 52.175],
  [5.1214, 52.0907],
  [5.5582, 52.0271],
  [5.6668, 51.9693],
];
// The last spot is next to Amersfoort Centraal
const OSCAR_SPOTS: LngLat[] = [
  [5.4, 52.16],
  [5.374, 52.1532],
];
const SEEDED_POSITIONS = [...ALPHA_HINTS, ...OSCAR_SPOTS];

async function removeSeededMarkers() {
  await Marker.deleteMany({ $or: SEEDED_POSITIONS.map((position) => ({ "location.coordinates": position })) });
}

if (process.argv.includes("--clean")) {
  await Team.deleteMany({ apiId: { $gte: 990000 } });
  await removeSeededMarkers();
  await GroupVisit.deleteMany({ teamApiId: { $gte: 990000 } });
  await Promise.all([Prediction.deleteMany({}), RoutingCache.deleteMany({})]);
  console.log("Removed seeded fox prediction data (teams, markers, visits, predictions, routing cache)");
  await mongoose.disconnect();
  process.exit(0);
}

function team(apiId: number, area: string, [lng, lat]: LngLat, name: string) {
  return {
    apiId,
    name,
    accomodation: "Testclubhuis",
    street: "Teststraat",
    houseNumber: apiId % 100,
    postCode: "0000AA",
    city: "Teststad",
    area,
    location: { type: "Point", coordinates: [lng, lat] },
  };
}

const currentHour = new Date();
currentHour.setUTCMinutes(0, 0, 0);
const hoursAgo = (hours: number) => new Date(currentHour.getTime() - hours * 3_600_000);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

await Team.deleteMany({ apiId: { $gte: 990000 } });
await Team.insertMany([
  ...ALPHA_GROUPS.map((location, index) => team(990000 + index, "alpha", location, `Testgroep Alpha ${index + 1}`)),
  ...OSCAR_GROUPS.map((location, index) => team(990100 + index, "oscar", location, `Testgroep Oscar ${index + 1}`)),
]);
await removeSeededMarkers();
await Marker.insertMany([
  ...ALPHA_HINTS.map((position, index) => ({ area: "alpha", type: MarkerType.Hint, time: hoursAgo(2 - index), location: { type: "Point", coordinates: position } })),
  ...OSCAR_SPOTS.map((position, index) => ({ area: "oscar", type: MarkerType.Spot, time: minutesAgo(index === 0 ? 90 : 45), location: { type: "Point", coordinates: position } })),
]);
await Area.updateOne({ name: "Alpha" }, { $set: { status: "green", updatedAt: new Date() } }, { upsert: true });
await Area.updateOne({ name: "Oscar" }, { $set: { status: "orange", updatedAt: new Date() } }, { upsert: true });

for (const area of ["alpha", "oscar"]) {
  const prediction = await predictionService.recomputeArea(area);
  console.log(`${area}: confidence=${prediction.confidence} stale=${prediction.stale} round=${prediction.round} ${prediction.reason ?? prediction.why}`);
  for (const candidate of prediction.candidates) {
    console.log(`  ${candidate.name}: ${Math.round(candidate.probability * 100)}%, eta ${candidate.eta.toISOString()} (${candidate.walkMinutes} min lopen)`);
  }
}
console.log(`Stored predictions: ${(await listPredictions()).length}`);
await mongoose.disconnect();
process.exit(0);
