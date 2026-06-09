import type { SemaphoreInput, SemaphoreResult, SemaphoreState } from "./types";

/**
 * Pure function: compute budget semaphore state.
 *
 * - verde:    accumulated_spend < ceiling × (current_day / days_in_month)
 * - amarillo: ceiling × (current_day / days_in_month) ≤ accumulated_spend < ceiling
 * - rojo:     accumulated_spend ≥ ceiling
 *
 * Edge cases:
 * - ceiling = 0 → rojo if any spend > 0, verde if spend = 0
 * - current_day = 1 with 0 spend → verde
 * - accumulated_spend exactly = expected → amarillo (not verde)
 */
export function computeSemaphore(input: SemaphoreInput): SemaphoreResult {
  const { accumulated_spend, ceiling, current_day, days_in_month } = input;

  // Edge case: ceiling = 0 → avoid division by zero
  if (ceiling <= 0) {
    const state: SemaphoreState = accumulated_spend > 0 ? "rojo" : "verde";
    return { state, spent: accumulated_spend, ceiling, pct: 0, expected_pct: 0, day: current_day, days_in_month };
  }

  const expected_pct = current_day / days_in_month;
  const expected_spend = ceiling * expected_pct;
  const pct = accumulated_spend / ceiling;

  let state: SemaphoreState;
  if (accumulated_spend >= ceiling) {
    state = "rojo";
  } else if (accumulated_spend >= expected_spend) {
    state = "amarillo";
  } else {
    state = "verde";
  }

  return { state, spent: accumulated_spend, ceiling, pct, expected_pct, day: current_day, days_in_month };
}
