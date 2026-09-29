import { describe, expect, test } from "bun:test";
import { assignAreas, OSCAR_GROUPS, type GroupPoint } from "./assign-areas";
import { LETTER_AREAS, OSCAR } from "./constants";
import { createRng, DEMO_SEED } from "./prng";

/** 8 blobs of 6 groups on a 4×2 grid plus a few groups in the middle, like the Jotihunt region */
function makeGroups(): GroupPoint[] {
  const rng = createRng(42);
  const groups: GroupPoint[] = [];
  let apiId = 1;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      for (let i = 0; i < 6; i++) groups.push({ apiId: apiId++, lng: 5 + col * 0.4 + rng.range(-0.05, 0.05), lat: 52.4 - row * 0.4 + rng.range(-0.05, 0.05) });
    }
  }
  for (let i = 0; i < 4; i++) groups.push({ apiId: apiId++, lng: 5.6 + rng.range(-0.01, 0.01), lat: 52.2 + rng.range(-0.01, 0.01) });
  return groups;
}

describe("assignAreas", () => {
  test("assigns every group; 4 central groups get Oscar and all 8 letters are used", () => {
    const groups = makeGroups();
    const areas = assignAreas(groups, createRng(DEMO_SEED));
    expect(areas.size).toBe(groups.length);
    const oscar = [...areas].filter(([, area]) => area === OSCAR).map(([apiId]) => apiId);
    expect(oscar.sort((a, b) => a - b)).toEqual([49, 50, 51, 52]);
    expect(oscar.length).toBe(OSCAR_GROUPS);
    expect(new Set(areas.values())).toEqual(new Set([...LETTER_AREAS, OSCAR]));
  });

  test("letters in reading order: Alpha north-west, Delta north-east, Echo south-west, Hotel south-east; blobs stay together", () => {
    const areas = assignAreas(makeGroups(), createRng(DEMO_SEED));
    const blobArea = (blob: number) => new Set([1, 2, 3, 4, 5, 6].map((i) => areas.get(blob * 6 + i)));
    expect(blobArea(0)).toEqual(new Set(["Alpha"]));
    expect(blobArea(3)).toEqual(new Set(["Delta"]));
    expect(blobArea(4)).toEqual(new Set(["Echo"]));
    expect(blobArea(7)).toEqual(new Set(["Hotel"]));
  });

  test("stable: the same seed gives the same assignment, whatever the input order", () => {
    const groups = makeGroups();
    const a = assignAreas(groups, createRng(DEMO_SEED));
    const b = assignAreas(createRng(7).shuffle(groups), createRng(DEMO_SEED));
    expect([...b].sort((x, y) => x[0] - y[0])).toEqual([...a].sort((x, y) => x[0] - y[0]));
  });

  test("few groups: no Oscar when there are not more groups than letters; empty input gives nothing", () => {
    const groups = makeGroups().slice(0, 5);
    const areas = assignAreas(groups, createRng(DEMO_SEED));
    expect(areas.size).toBe(5);
    expect([...areas.values()]).not.toContain(OSCAR);
    expect(assignAreas([], createRng(DEMO_SEED)).size).toBe(0);
  });
});
