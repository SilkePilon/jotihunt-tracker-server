import { describe, expect, test } from "bun:test";
import { fromRd, toRd } from "../rd-answer";
import { bearingBetween, convexHull, distanceToHull, estimateArea, formatCoordinate, groupsWithin, insideNl, intersectRd, nearestGroups, parseCoordinate, projectFrom, type AreaGroup } from "./geo";

/** HQ Jotihunt, Stikkerstraat Arnhem (RD 188362 440722) */
const HQ = { lat: 51.95392, lng: 5.87252 };

describe("parseCoordinate", () => {
  test("RD in 4, 5 and 6 digits, with separators, dots, slash or glued", () => {
    for (const input of ["1883 4407", "18836 44072", "188362 440722", "188.362/440.722", "188362,440722", "RD: 188362 440722", "18834407", "188362440722"]) {
      const parsed = parseCoordinate(input);
      expect(parsed?.kind).toBe("rd");
      expect(Math.abs(parsed!.rd.x - 188362)).toBeLessThan(100);
      expect(Math.abs(parsed!.rd.y - 440722)).toBeLessThan(100);
      expect(Math.abs(parsed!.latLng.lat - HQ.lat)).toBeLessThan(0.002);
      expect(Math.abs(parsed!.latLng.lng - HQ.lng)).toBeLessThan(0.002);
    }
  });

  test("RD keeps the exact metres it was given", () => {
    expect(parseCoordinate("188362 440722")!.rd).toEqual({ x: 188362, y: 440722 });
    expect(parseCoordinate("1883 4407")!.rd).toEqual({ x: 188300, y: 440700 });
  });

  test("decimal degrees, also lng first and with decimal commas", () => {
    for (const input of ["51.95392, 5.87252", "51.95392 5.87252", "5.87252, 51.95392", "51,95392 5,87252"]) {
      const parsed = parseCoordinate(input);
      expect(parsed?.kind).toBe("decimal");
      expect(parsed!.latLng.lat).toBeCloseTo(51.95392, 5);
      expect(parsed!.latLng.lng).toBeCloseTo(5.87252, 5);
    }
  });

  test("degrees and minutes (and seconds) with hemisphere letters before or after", () => {
    const expectNear = (input: string, lat: number, lng: number) => {
      const parsed = parseCoordinate(input);
      expect(parsed?.kind).toBe("dms");
      expect(parsed!.latLng.lat).toBeCloseTo(lat, 5);
      expect(parsed!.latLng.lng).toBeCloseTo(lng, 5);
    };
    expectNear("N 52° 12.345 E 005° 52.123", 52 + 12.345 / 60, 5 + 52.123 / 60);
    expectNear("N52 12.345 E5 52.123", 52 + 12.345 / 60, 5 + 52.123 / 60);
    expectNear(`52°12'30"N 5°52'10"E`, 52 + 12 / 60 + 30 / 3600, 5 + 52 / 60 + 10 / 3600);
    expectNear("52°12,345' 5°52,123'", 52 + 12.345 / 60, 5 + 52.123 / 60);
    expectNear("N 52° 12.345 O 5° 52.123", 52 + 12.345 / 60, 5 + 52.123 / 60);
  });

  test("nonsense, out of range and unequal RD halves give null", () => {
    for (const input of ["", "hallo", "1234 56789", "999999 999999", "123 456", "N 95° 00.000 E 5° 00.000", "52° 75.000 5° 10.000"]) {
      expect(parseCoordinate(input)).toBeNull();
    }
  });
});

describe("formatCoordinate", () => {
  test("gives the 8-digit answer, full RD, decimal and degrees-minutes", () => {
    const formatted = formatCoordinate(parseCoordinate("188362 440722")!);
    expect(formatted.rd8).toBe("1884 4407");
    expect(formatted.rdFull).toBe("188362 440722");
    expect(formatted.decimal).toMatch(/^51\.95\d{3}, 5\.87\d{3}$/);
    expect(formatted.dm).toMatch(/^N 51° 57\.\d{3}' E 5° 52\.\d{3}'$/);
  });
});

describe("insideNl", () => {
  test("a rough box around the Netherlands", () => {
    expect(insideNl(HQ)).toBe(true);
    expect(insideNl({ lat: 48.85, lng: 2.35 })).toBe(false);
  });
});

/** Groups on a 3x3 km grid east and west of a centre, in RD metres */
function groupAt(name: string, area: string | null, dx: number, dy: number): AreaGroup {
  const base = toRd(HQ.lng, HQ.lat);
  const parsed = parseCoordinate(`${Math.round(base.x + dx)} ${Math.round(base.y + dy)}`)!;
  return { name, area, ...parsed.latLng };
}
const pointAt = (dx: number, dy: number) => {
  const { lat, lng } = groupAt("p", null, dx, dy);
  return { lat, lng };
};

const GROUPS: AreaGroup[] = [
  groupAt("W1", "alpha", -10_000, 0),
  groupAt("W2", "alpha", -10_000, 3000),
  groupAt("W3", "alpha", -7000, 1500),
  groupAt("E1", "bravo", 10_000, 0),
  groupAt("E2", "bravo", 10_000, 3000),
  groupAt("E3", "bravo", 7000, 1500),
  groupAt("X", null, 0, 20_000),
];

describe("convexHull / distanceToHull", () => {
  test("hull of a square drops the inner point; distance 0 inside, to the edge outside", () => {
    const hull = convexHull([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5],
    ]);
    expect(hull).toHaveLength(4);
    expect(distanceToHull([5, 5], hull)).toBe(0);
    expect(distanceToHull([15, 5], hull)).toBeCloseTo(5);
  });

  test("one point and a segment work as hulls too", () => {
    expect(distanceToHull([3, 4], [[0, 0]])).toBeCloseTo(5);
    expect(
      distanceToHull(
        [5, 3],
        [
          [0, 0],
          [10, 0],
        ],
      ),
    ).toBeCloseTo(3);
  });
});

describe("estimateArea", () => {
  test("inside one area's hull (or within 1 km of it) → hull", () => {
    expect(estimateArea(pointAt(-9000, 1500), GROUPS)).toEqual({ area: "alpha", method: "hull" });
    expect(estimateArea(pointAt(-6200, 1500), GROUPS)).toEqual({ area: "alpha", method: "hull" });
  });

  test("outside every hull → the nearest group's area", () => {
    expect(estimateArea(pointAt(4000, 1500), GROUPS)).toEqual({ area: "bravo", method: "nearest-group" });
  });

  test("no group has an area → none", () => {
    expect(estimateArea(HQ, [groupAt("X", null, 0, 0)])).toEqual({ area: null, method: "none" });
  });
});

describe("nearestGroups / groupsWithin", () => {
  test("sorted by distance, rounded metres", () => {
    const nearest = nearestGroups(pointAt(6500, 1200), GROUPS, 2);
    expect(nearest.map((group) => group.name)).toEqual(["E3", "E1"]);
    expect(nearest[0].distanceM).toBeGreaterThan(400);
    expect(nearest[0].distanceM).toBeLessThan(700);
    expect(Number.isInteger(nearest[0].distanceM)).toBe(true);
  });

  test("groupsWithin keeps only groups inside the radius", () => {
    expect(groupsWithin(pointAt(6500, 1200), GROUPS, 4000).map((group) => group.name)).toEqual(["E3", "E1", "E2"]);
  });
});

describe("projectFrom / bearingBetween", () => {
  test("7.31 km at 262 degrees from HQ (the 2025 'One Ring' hint) lands about 7.2 km west, 1 km south", () => {
    const target = projectFrom(HQ, 262, 7310);
    const hq = toRd(HQ.lng, HQ.lat);
    const rd = toRd(target.lng, target.lat);
    expect(Math.abs(rd.x - hq.x - -7239)).toBeLessThan(100);
    expect(Math.abs(rd.y - hq.y - -1017)).toBeLessThan(100);
    expect(bearingBetween(HQ, target)).toBeCloseTo(262, 0);
  });

  test("bearing is 0-360", () => {
    expect(bearingBetween(HQ, projectFrom(HQ, 350, 1000))).toBeCloseTo(350, 0);
  });
});

describe("intersectRd", () => {
  const at = (x: number, y: number) => {
    const { lat, lng } = fromRd(x, y);
    return { lat, lng };
  };
  const A = at(180_000, 440_000);
  const B = at(190_000, 440_000);
  const C = at(185_000, 450_000);
  const TARGET = { x: 185_000, y: 445_000 };
  const near = (rd: { x: number; y: number }, expected: { x: number; y: number }, metres = 5) => {
    expect(Math.abs(rd.x - expected.x)).toBeLessThan(metres);
    expect(Math.abs(rd.y - expected.y)).toBeLessThan(metres);
  };
  const toward = (from: { lat: number; lng: number }) => bearingBetween(from, at(TARGET.x, TARGET.y));

  test("two bearings meet in one point", () => {
    const result = intersectRd({ bearings: [{ from: A, bearingDeg: toward(A) }, { from: B, bearingDeg: toward(B) }] });
    expect(result.points).toHaveLength(1);
    near(result.points[0].rd, TARGET);
    expect(result.note).toBeUndefined();
  });

  test("three bearings: the least-squares point first", () => {
    const result = intersectRd({ bearings: [{ from: A, bearingDeg: toward(A) }, { from: B, bearingDeg: toward(B) }, { from: C, bearingDeg: toward(C) + 1 }] });
    near(result.points[0].rd, TARGET, 120);
    expect(result.points.length).toBeLessThanOrEqual(2);
  });

  test("parallel lines and lines that only cross behind a start point give a note", () => {
    expect(intersectRd({ bearings: [{ from: A, bearingDeg: 0 }, { from: B, bearingDeg: 0 }] })).toEqual({ points: [], note: "De peilingen lopen evenwijdig; er is geen snijpunt" });
    expect(intersectRd({ bearings: [{ from: A, bearingDeg: toward(A) + 180 }, { from: B, bearingDeg: toward(B) + 180 }] })).toEqual({
      points: [],
      note: "De peilingen snijden alleen achter een startpunt; er is geen snijpunt",
    });
  });

  test("two circles: two points, one when they touch, none apart", () => {
    const r = Math.hypot(5000, 5000);
    const two = intersectRd({ circles: [{ center: A, radiusM: r }, { center: B, radiusM: r }] });
    expect(two.points).toHaveLength(2);
    const ys = two.points.map((point) => point.rd.y).sort((p, q) => p - q);
    near({ x: two.points[0].rd.x, y: ys[0] }, { x: 185_000, y: 435_000 });
    near({ x: two.points[1].rd.x, y: ys[1] }, TARGET);
    const touch = intersectRd({ circles: [{ center: A, radiusM: 5000 }, { center: B, radiusM: 5000 }] });
    expect(touch.points).toHaveLength(1);
    near(touch.points[0].rd, { x: 185_000, y: 440_000 });
    expect(intersectRd({ circles: [{ center: A, radiusM: 1000 }, { center: B, radiusM: 1000 }] })).toEqual({ points: [], note: "De cirkels raken elkaar niet; er is geen snijpunt" });
  });

  test("a bearing and a circle", () => {
    const result = intersectRd({ bearings: [{ from: A, bearingDeg: toward(A) }], circles: [{ center: B, radiusM: Math.hypot(5000, 5000) }] });
    expect(result.points).toHaveLength(1);
    near(result.points[0].rd, TARGET);
    expect(intersectRd({ bearings: [{ from: A, bearingDeg: 270 }], circles: [{ center: B, radiusM: 1000 }] })).toEqual({ points: [], note: "De peiling raakt de cirkel niet; er is geen snijpunt" });
  });

  test("only points: their centroid", () => {
    const result = intersectRd({ points: [A, B, C] });
    expect(result.points).toHaveLength(1);
    near(result.points[0].rd, { x: 185_000, y: 443_333 });
    expect(result.note).toBe("Middelpunt van 3 punten");
  });
});
