import { adminConfig, AI_SLOTS, PLAIN_NAMES, SECRET_NAMES, secret, setAiModels, setGeneral, setPlain, setSecret, settingsKeyOk, VEHICLE_KEYS, type GeneralSettings } from "./app-config";

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
    if (sourced.source !== "env") continue;
    if (key === "vehicleGroups") {
      const ids = sourced.value as Record<(typeof VEHICLE_KEYS)[number], number | null>;
      generalPatch.vehicleGroups = Object.fromEntries(VEHICLE_KEYS.filter((v) => ids[v] !== null).map((v) => [v, ids[v]]));
    } else {
      (generalPatch as Record<string, unknown>)[key] = sourced.value;
    }
    copied.push(key);
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
