import { Team } from "../models/team.model";
import { ApiTeam } from "../types/api";
import { getTeams } from "./jotihunt.service";

function toTeamFields(team: ApiTeam) {
  return {
    name: team.name,
    accomodation: team.accomodation,
    street: team.street,
    houseNumber: team.housenumber,
    housenumberAddition: team.housenumber_addition,
    postCode: team.postcode,
    city: team.city,
    location: {
      type: "Point" as const,
      coordinates: [Number(team.long), Number(team.lat)],
    },
  };
}

let running: Promise<number> | undefined;

/**
 * Upsert all teams from the Jotihunt API, keyed by apiId, and remove teams that are no longer subscribed.
 * The API returns `area: null` before the hunt, so an area assigned in the app (and the scraped logoUrl)
 * is kept unless the API provides an area. Concurrent calls share one run.
 * @returns the number of teams from the API
 */
export function syncTeams(fetchTeams: () => Promise<ApiTeam[]> = getTeams): Promise<number> {
  running ??= (async () => {
    const apiTeams = await fetchTeams();
    if (apiTeams.length === 0) throw new Error("Jotihunt API returned no teams");

    await Team.bulkWrite(
      apiTeams.map((team) => ({
        updateOne: {
          filter: { apiId: team.id },
          update: { $set: { ...toTeamFields(team), ...(team.area ? { area: team.area } : {}) } },
          upsert: true,
        },
      })),
    );
    await Team.deleteMany({ apiId: { $nin: apiTeams.map((team) => team.id) } });
    return apiTeams.length;
  })().finally(() => {
    running = undefined;
  });
  return running;
}
