import { Area } from "../models/area.model";
import { Marker, MarkerType } from "../models/marker.model";
import { Team } from "../models/team.model";
import type { LngLat } from "../services/prediction/types";

export async function makeTeam(apiId: number, area: string, [lng, lat]: LngLat, name = `Groep ${apiId}`) {
  return Team.create({
    apiId,
    name,
    accomodation: "Clubhuis",
    street: "Straat",
    houseNumber: 1,
    postCode: "1234AB",
    city: "Plaats",
    area,
    location: { type: "Point", coordinates: [lng, lat] },
  });
}

export async function addObservation(area: string, time: Date, [lng, lat]: LngLat, type: MarkerType = MarkerType.Hint) {
  return Marker.create({ area, time, type, location: { type: "Point", coordinates: [lng, lat] } });
}

export async function setAreaStatus(name: string, status: "green" | "orange" | "red", updatedAt = new Date()) {
  await Area.updateOne({ name }, { $set: { status, updatedAt } }, { upsert: true });
}
