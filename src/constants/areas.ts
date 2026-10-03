/** The nine fox teams (deelgebieden), lowercase like Marker.area, HintCell.area and HuntReport.area. */
export const AREAS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "oscar"] as const;

export type AreaName = (typeof AREAS)[number];

/** Fox team statuses of the Jotihunt API: green (actief), orange (onderweg), red (inactief). */
export const AREA_STATUSES = ["green", "orange", "red"] as const;

export type AreaStatus = (typeof AREA_STATUSES)[number];

/** Lowercase area name when it is one of the known areas (any casing), else null. */
export function knownAreaName(name: unknown): AreaName | null {
  if (typeof name !== "string") return null;
  const lower = name.trim().toLowerCase();
  return (AREAS as readonly string[]).includes(lower) ? (lower as AreaName) : null;
}

/** The name as the Jotihunt API writes it (Area.name, Team.area): "alpha" → "Alpha". */
export function areaTitle(area: AreaName): string {
  return area.charAt(0).toUpperCase() + area.slice(1);
}

/** Area.name values of the known areas ("Alpha" … "Oscar"). */
export const AREA_TITLES: readonly string[] = AREAS.map(areaTitle);
