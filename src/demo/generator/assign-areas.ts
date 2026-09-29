import { LETTER_AREAS, OSCAR, type DemoArea } from "./constants";
import type { Rng } from "./prng";

export interface GroupPoint {
  apiId: number;
  lng: number;
  lat: number;
}

/** Number of groups nearest to the centre of all groups that form Oscar. */
export const OSCAR_GROUPS = 4;

interface Xy {
  x: number;
  y: number;
}

/** Equirectangular projection around a reference latitude (good enough for a province). */
function project(point: GroupPoint, cosLat: number): Xy {
  return { x: point.lng * cosLat, y: point.lat };
}

function dist2(a: Xy, b: Xy): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function mean(points: Xy[]): Xy {
  return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
}

/** k-means with k-means++ seeding; deterministic for a given rng state and input order. Returns the cluster per point. */
export function kMeans(points: Xy[], k: number, rng: Rng, maxIterations = 100): number[] {
  if (points.length === 0 || k <= 0) return points.map(() => 0);
  const centroids: Xy[] = [points[Math.floor(rng.next() * points.length)]];
  while (centroids.length < k) {
    const weights = points.map((p) => Math.min(...centroids.map((c) => dist2(p, c))));
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (total === 0) {
      centroids.push(points[centroids.length % points.length]);
      continue;
    }
    let target = rng.next() * total;
    let index = 0;
    for (; index < points.length - 1; index++) {
      target -= weights[index];
      if (target < 0) break;
    }
    centroids.push(points[index]);
  }

  let assignment = points.map(() => -1);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const next = points.map((p) => {
      let best = 0;
      for (let c = 1; c < k; c++) if (dist2(p, centroids[c]) < dist2(p, centroids[best])) best = c;
      return best;
    });
    // An empty cluster takes the point farthest from its own centroid
    for (let c = 0; c < k; c++) {
      if (next.includes(c)) continue;
      let far = -1;
      let farDist = -1;
      next.forEach((cluster, index) => {
        const members = next.filter((other) => other === cluster).length;
        const d = dist2(points[index], centroids[cluster]);
        if (members > 1 && d > farDist) {
          far = index;
          farDist = d;
        }
      });
      if (far >= 0) next[far] = c;
    }
    const changed = next.some((cluster, index) => cluster !== assignment[index]);
    assignment = next;
    for (let c = 0; c < k; c++) {
      const members = points.filter((_, index) => assignment[index] === c);
      if (members.length) centroids[c] = mean(members);
    }
    if (!changed) break;
  }
  return assignment;
}

/**
 * Assign every group to a fox area: the 4 groups nearest to the centre of all groups get Oscar, the rest is split
 * by k-means (k = 8) into Alpha…Hotel, lettered in reading order (north row west→east, then the south row).
 * Deterministic: the input order does not matter (sorted by apiId first).
 */
export function assignAreas(groups: GroupPoint[], rng: Rng): Map<number, DemoArea> {
  const result = new Map<number, DemoArea>();
  if (groups.length === 0) return result;
  const sorted = [...groups].sort((a, b) => a.apiId - b.apiId);
  const cosLat = Math.cos((sorted.reduce((sum, g) => sum + g.lat, 0) / sorted.length) * (Math.PI / 180));
  const xy = sorted.map((g) => project(g, cosLat));
  const centre = mean(xy);

  const oscarCount = Math.max(0, Math.min(OSCAR_GROUPS, sorted.length - LETTER_AREAS.length));
  const byCentre = sorted.map((_, index) => index).sort((a, b) => dist2(xy[a], centre) - dist2(xy[b], centre) || sorted[a].apiId - sorted[b].apiId);
  const oscar = new Set(byCentre.slice(0, oscarCount));
  for (const index of oscar) result.set(sorted[index].apiId, OSCAR);

  const rest = sorted.map((_, index) => index).filter((index) => !oscar.has(index));
  const k = Math.min(LETTER_AREAS.length, rest.length);
  const clusters = kMeans(
    rest.map((index) => xy[index]),
    k,
    rng,
  );
  const centroids = Array.from({ length: k }, (_, c) => mean(rest.filter((_, i) => clusters[i] === c).map((index) => xy[index])));
  const byNorth = centroids.map((_, c) => c).sort((a, b) => centroids[b].y - centroids[a].y || centroids[a].x - centroids[b].x);
  const rowSize = Math.ceil(k / 2);
  const ordered = [...byNorth.slice(0, rowSize).sort((a, b) => centroids[a].x - centroids[b].x), ...byNorth.slice(rowSize).sort((a, b) => centroids[a].x - centroids[b].x)];
  const letterOf = new Map(ordered.map((cluster, position) => [cluster, LETTER_AREAS[position]]));
  rest.forEach((index, i) => result.set(sorted[index].apiId, letterOf.get(clusters[i])!));
  return result;
}
