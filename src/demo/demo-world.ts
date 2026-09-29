import { onDemoSwitch, readRealCollection, setDemoWorldGenerator } from "./database-switch";
import { generateDemoWorld, type RealTeam } from "./generator/generate-world";
import { setSimulation } from "./simulated-trackers";

/**
 * Plug the demo world generator into the database switch (call before initDemoMode). Teams and transit stops are
 * read from the real database; the simulated trackers are forgotten when demo mode goes off.
 */
export function installDemoWorld(log: (message: string) => void = () => undefined) {
  setDemoWorldGenerator((now) =>
    generateDemoWorld(now, {
      sources: {
        teams: () => readRealCollection<RealTeam>("teams"),
        transitStops: () => readRealCollection("transitstops"),
      },
      log,
    }),
  );
  onDemoSwitch((enabled) => {
    if (!enabled) setSimulation(null);
  });
}
