import { adminConfig, AI_SLOTS, PLAIN_NAMES, SECRET_NAMES, secret, setAiModels, setGeneral, setPlain, setSecret, settingsKeyOk, VEHICLE_KEYS, vehicleGroupSources, type GeneralSettings } from "./app-config";

/**
 * One-off: copy every setting that still comes from env into the database (Beheer), so the env vars can be removed.
 * DB values are never overwritten; secrets need SETTINGS_KEY. Running it again copies nothing.
 */
export async function migrateEnvSettings(by: string): Promise<{ copied: string[]; skippedSecrets: string[] }> {
  const view = adminConfig();
  const copied: string[] = [];
  const skippedSecrets: string[] = [];

  const generalPatch: GeneralSettings = {};
  for (const [key, sourced] of Object.entries(view.general) as [keyof typeof view.general, { value: unknown; source: string }][]) {
    if (key === "vehicleGroups") continue;
    if (sourced.source !== "env") continue;
    (generalPatch as Record<string, unknown>)[key] = sourced.value;
    copied.push(key);
  }
  // Per vehicle: the group may be partly stored already (its overall source is then "db")
  const vehicles = vehicleGroupSources();
  const envVehicles = VEHICLE_KEYS.filter((v) => vehicles[v].source === "env");
  if (envVehicles.length) {
    generalPatch.vehicleGroups = Object.fromEntries(envVehicles.map((v) => [v, vehicles[v].value]));
    copied.push(...envVehicles.map((v) => `vehicleGroups.${v}`));
  }
  if (Object.keys(generalPatch).length) await setGeneral(generalPatch, by);

  const models = Object.fromEntries(AI_SLOTS.filter((slot) => view.ai[slot].source === "env").map((slot) => [slot, view.ai[slot].value]));
  if (Object.keys(models).length) {
    await setAiModels(models, by);
    copied.push(...Object.keys(models).map((slot) => `ai.${slot}`));
  }

  const plainPatch = Object.fromEntries(PLAIN_NAMES.filter((name) => view.plain[name].source === "env").map((name) => [name, view.plain[name].value]));
  if (Object.keys(plainPatch).length) {
    await setPlain(plainPatch, by);
    copied.push(...Object.keys(plainPatch));
  }

  for (const name of SECRET_NAMES) {
    if (view.secrets[name].source !== "env") continue;
    if (!settingsKeyOk()) {
      skippedSecrets.push(name);
      continue;
    }
    await setSecret(name, secret(name), by);
    copied.push(name);
  }
  return { copied, skippedSecrets };
}
