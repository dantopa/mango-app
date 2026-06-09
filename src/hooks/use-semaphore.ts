"use client";

import { useQuery } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import { computeSemaphore } from "@/lib/push-ingest/semaphore";
import type { SemaphoreResult } from "@/lib/push-ingest/types";

const supabase = createClient();

/** Monthly budget ceiling in USD. Configurable — hardcoded placeholder for now. */
const BUDGET_CEILING_USD = 2000;

export type SemaphoreData = SemaphoreResult & {
  /** Rolling daily budget: (ceiling - spent) / remaining days */
  daily_budget: number;
};

/**
 * Get the first and last day of the current month as ISO date strings.
 */
function getCurrentMonthRange(): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0); // last day of current month

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  return { start: fmt(start), end: fmt(end) };
}

/**
 * Get today's day of month and total days in month.
 */
function getMonthInfo(): { currentDay: number; daysInMonth: number } {
  const now = new Date();
  const currentDay = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return { currentDay, daysInMonth };
}

/**
 * TanStack Query hook for the budget semaphore.
 *
 * - Queries current month's variable expenses (is_payment=false, expense_type='variable')
 * - Computes semaphore state
 * - Returns semaphore result + rolling daily budget
 */
export function useSemaphore() {
  return useQuery<SemaphoreData>({
    queryKey: ["semaphore", "current-month"],
    queryFn: async (): Promise<SemaphoreData> => {
      const { start, end } = getCurrentMonthRange();
      const { currentDay, daysInMonth } = getMonthInfo();

      // Query accumulated variable expenses for current month
      // is_payment=false excludes transfers, expense_type='variable' for regular expenses
      const { data, error } = await supabase
        .from("transactions")
        .select("amount_usd")
        .eq("is_payment", false)
        .eq("expense_type", "variable")
        .gte("tx_date", start)
        .lte("tx_date", end);

      if (error) throw error;

      // Sum all expense amounts (amount_usd > 0 = expense in this model)
      const accumulatedSpend = (data ?? []).reduce(
        (sum, tx) => sum + (tx.amount_usd > 0 ? tx.amount_usd : 0),
        0,
      );

      const semaphore = computeSemaphore({
        accumulated_spend: accumulatedSpend,
        ceiling: BUDGET_CEILING_USD,
        current_day: currentDay,
        days_in_month: daysInMonth,
      });

      // Rolling daily budget: (ceiling - spent) / remaining days
      const remainingDays = daysInMonth - currentDay + 1; // include today
      const dailyBudget =
        remainingDays > 0
          ? Math.max(0, (BUDGET_CEILING_USD - accumulatedSpend) / remainingDays)
          : 0;

      return {
        ...semaphore,
        daily_budget: Math.round(dailyBudget * 100) / 100,
      };
    },
  });
}
