import type { NightArea } from "../services/routes/graphhopper.client";

/** Global AI fox prediction switch; one document (key "prediction") in the `settings` collection. */
export interface PredictionSettingDoc {
  key: string;
  enabled: boolean;
  updatedAt?: Date | null;
  updatedBy?: string | null;
}

/** Fox teams we may hunt besides our own (rule 5.1); one document (key "huntable-areas") in the `settings` collection. */
export interface HuntableAreasSettingDoc {
  key: string;
  /** Lowercase area names, sorted, without duplicates */
  areas: string[];
  updatedAt?: Date | null;
  updatedBy?: string | null;
}

/** Routed trails: on/off + admin night areas; one document (key "night-areas") in the `settings` collection. */
export interface NightAreasSettingDoc {
  key: string;
  enabled: boolean;
  areas: NightArea[];
  updatedAt?: Date | null;
  updatedBy?: string | null;
}
