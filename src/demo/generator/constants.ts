import type { Vehicle } from "../../services/tracker-onboarding.helpers";

/** Fox areas as the Jotihunt API names them (Area.name, Team.area); markers/cells use the lowercase form. */
export const LETTER_AREAS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"] as const;
export const OSCAR = "Oscar";
export const DEMO_AREAS = [...LETTER_AREAS, OSCAR] as const;
export type DemoArea = (typeof DEMO_AREAS)[number];

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/** Demo article ids: the real 2025 ids + this offset (seed-hint uses 900000+). */
export const ARTICLE_ID_OFFSET = 800_000;

export interface DemoHunter {
  name: string;
  vehicle: Exclude<Vehicle, "motorcycle">;
}

/** The 8 simulated hunters: 3 by car, 3 by bike, 2 walking. */
export const DEMO_HUNTERS: readonly DemoHunter[] = [
  { name: "Merida", vehicle: "car" },
  { name: "Mulan", vehicle: "bike" },
  { name: "Moana", vehicle: "walking" },
  { name: "Tiana", vehicle: "car" },
  { name: "Elsa", vehicle: "bike" },
  { name: "Rapunzel", vehicle: "car" },
  { name: "Belle", vehicle: "bike" },
  { name: "Pocahontas", vehicle: "walking" },
];

/** First Traccar device id of the simulated trackers (far above real Traccar ids). */
export const DEMO_DEVICE_ID_BASE = 900_001;

/** Short puzzle notes hunters leave on hint cells. */
export const HINT_NOTES = [
  "Lijkt op een rebus, eerste woord is 'toren'?",
  "Coördinaten staan in spiegelschrift",
  "Getallen in Romeinse cijfers, al omgerekend",
  "Het plaatje is een stuk kaart van de Veluwe",
  "Morse in de rand van het plaatje",
  "Ik denk dat het een kerk in het dorp is",
  "Letters tellen per regel geeft de X",
  "Anagram van een straatnaam?",
  "Kaart gedraaid, noorden staat onder",
  "Check even de laatste twee cijfers, twijfel tussen 3 en 8",
  "Tekst achterstevoren lezen",
  "Zelfde puzzel als vorig uur, andere getallen",
];
