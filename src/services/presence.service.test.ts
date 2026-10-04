import { describe, expect, test } from "bun:test";
import { createPresence, PRESENCE_TTL_MS } from "./presence.service";

const sanne = { _id: "u1", name: "Sanne" };
const daan = { _id: "u2", name: "Daan" };

function clocked() {
  let now = 1_000_000;
  const presence = createPresence({ now: () => now });
  return { presence, advance: (ms: number) => (now += ms) };
}

describe("presence", () => {
  test("the default lifetime is 25 seconds", () => {
    expect(PRESENCE_TTL_MS).toBe(25_000);
  });

  test("a heartbeat lists the user on that item", () => {
    const { presence } = clocked();
    presence.beat(sanne, 5, "charlie");
    expect(presence.list()).toEqual([{ userId: "u1", name: "Sanne", itemId: 5, area: "charlie", at: 1_000_000 }]);
  });

  test("a user is on one item at a time: the newest heartbeat replaces the old one", () => {
    const { presence, advance } = clocked();
    presence.beat(sanne, 5, "charlie");
    advance(1000);
    presence.beat(sanne, 6);
    expect(presence.list()).toEqual([{ userId: "u1", name: "Sanne", itemId: 6, area: undefined, at: 1_001_000 }]);
  });

  test("an entry disappears 25 seconds after its last heartbeat", () => {
    const { presence, advance } = clocked();
    presence.beat(sanne, 5);
    advance(10_000);
    presence.beat(daan, 5);
    advance(15_000); // sanne: exactly 25 s old
    expect(presence.list().map((entry) => entry.name)).toEqual(["Daan"]);
    advance(10_001);
    expect(presence.list()).toEqual([]);
  });

  test("clear removes everyone", () => {
    const { presence } = clocked();
    presence.beat(sanne, 5);
    presence.beat(daan, 6);
    presence.clear();
    expect(presence.list()).toEqual([]);
  });

  test("leave removes the user at once", () => {
    const { presence } = clocked();
    presence.beat(sanne, 5);
    presence.beat(daan, 5);
    presence.leave("u1");
    expect(presence.list().map((entry) => entry.name)).toEqual(["Daan"]);
  });
});
