import { afterEach, describe, expect, test } from "bun:test";
import { distanceM } from "../services/prediction/geo";
import { hunterPosition, setSimulation, simulatedDevices, simulatedPositions, simulatedSummaries, type SimulatedHunter } from "./simulated-trackers";

const huntStart = new Date("2026-10-17T09:00:00Z");
const now = new Date("2026-10-17T15:00:00Z");
const hunter = (deviceId: number, vehicle: SimulatedHunter["vehicle"], inactive = false): SimulatedHunter => ({
  deviceId,
  uniqueId: `demo-${deviceId}`,
  name: `H${deviceId}`,
  vehicle,
  centre: [5.9, 52.1],
  radiusM: 2000,
  phase: 1,
  direction: 1,
  inactive,
  battery: 90,
});

afterEach(() => setSimulation(null));

describe("simulated trackers", () => {
  test("nothing without a simulation", () => {
    expect(simulatedDevices(now, { walking: 1, bike: 2, car: 3, motorcycle: undefined })).toEqual([]);
    expect(simulatedSummaries(now)).toBeNull();
  });

  test("devices and positions in the Traccar shape; inactive ones 12 minutes old", () => {
    setSimulation({ huntStart, hunters: [hunter(900001, "car"), hunter(900002, "walking", true)] });
    const devices = simulatedDevices(now, { walking: 1, bike: 2, car: 3, motorcycle: undefined });
    expect(devices.map((device) => [device.id, device.groupId, device.status])).toEqual([
      [900001, 3, "online"],
      [900002, 1, "offline"],
    ]);
    const positions = simulatedPositions(now);
    expect(positions[0].fixTime).toBe(now.toISOString());
    expect(Date.parse(positions[1].fixTime)).toBe(now.getTime() - 12 * 60_000);
    expect(positions[0].deviceId).toBe(devices[0].id);
    expect(positions[0].speed * 1.852).toBeCloseTo(40, 5);
    expect(positions[1].speed).toBe(0);
  });

  test("positions advance with time at about the vehicle speed and stay near the area", () => {
    const car = hunter(900001, "car");
    const a = hunterPosition(car, huntStart, now);
    const b = hunterPosition(car, huntStart, new Date(now.getTime() + 60_000));
    const moved = distanceM(a, b);
    expect(moved).toBeGreaterThan(300);
    expect(moved).toBeLessThan(1200);
    expect(distanceM(a, car.centre)).toBeLessThan(car.radiusM * 1.4);
  });

  test("leaderboard distance: speed × moving time since hunt start", () => {
    setSimulation({ huntStart, hunters: [hunter(900001, "walking"), hunter(900002, "walking", true)] });
    const { from, summaries } = simulatedSummaries(now)!;
    expect(from).toEqual(huntStart);
    expect(summaries.get(900001)!.distanceM).toBe(Math.round(5 * 0.8 * 6 * 1000));
    expect(summaries.get(900002)!.distanceM).toBeLessThan(summaries.get(900001)!.distanceM);
  });
});
