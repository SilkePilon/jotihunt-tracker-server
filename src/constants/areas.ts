/** The nine fox teams (deelgebieden), lowercase like Marker.area, HintCell.area and HuntReport.area. */
export const AREAS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "oscar"] as const;

export type AreaName = (typeof AREAS)[number];
