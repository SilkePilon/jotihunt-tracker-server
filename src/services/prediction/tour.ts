/**
 * Cost of an open tour that starts at the fixed start position.
 * @param tour Node indices in visiting order
 * @param startCosts Cost from the start position to node i
 * @param matrix Cost from node i to node j
 */
export function tourCost(tour: number[], startCosts: number[], matrix: number[][]): number {
  if (tour.length === 0) return 0;
  let cost = startCosts[tour[0]];
  for (let i = 1; i < tour.length; i++) cost += matrix[tour[i - 1]][tour[i]];
  return cost;
}

/** Improve an open tour by reversing segments until no reversal helps (costs may be asymmetric). */
export function twoOpt(tour: number[], startCosts: number[], matrix: number[][]): number[] {
  let best = [...tour];
  let bestCost = tourCost(best, startCosts, matrix);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const cost = tourCost(candidate, startCosts, matrix);
        if (cost < bestCost - 1e-9) {
          best = candidate;
          bestCost = cost;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * Shortest open tour from a fixed start through all nodes: nearest neighbour, then 2-opt.
 * @returns Node indices in visiting order (first element = first stop)
 */
export function planTour(startCosts: number[], matrix: number[][]): number[] {
  const remaining = new Set(startCosts.map((_, index) => index));
  const tour: number[] = [];
  let current = -1;
  while (remaining.size > 0) {
    let best = -1;
    let bestCost = Infinity;
    for (const node of remaining) {
      const cost = current === -1 ? startCosts[node] : matrix[current][node];
      if (best === -1 || cost < bestCost) {
        best = node;
        bestCost = cost;
      }
    }
    tour.push(best);
    remaining.delete(best);
    current = best;
  }
  return twoOpt(tour, startCosts, matrix);
}
