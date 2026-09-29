/** Seed of the demo world: the same teams and "now" always give the same world. */
export const DEMO_SEED = 20261017;

export interface Rng {
  /** Uniform in [0, 1) */
  next(): number;
  /** Uniform in [min, max) */
  range(min: number, max: number): number;
  /** Integer in [min, max] */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** A shuffled copy */
  shuffle<T>(items: readonly T[]): T[];
  chance(probability: number): boolean;
}

/** Small seeded PRNG (mulberry32): deterministic, not for secrets. */
export function createRng(seed: number = DEMO_SEED): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      if (items.length === 0) throw new Error("Cannot pick from an empty list");
      return items[Math.floor(next() * items.length)];
    },
    shuffle: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
    chance: (probability) => next() < probability,
  };
  return rng;
}
