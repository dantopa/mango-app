"use client";

import { useQuery } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import { computeSemaphore } from "@/lib/push-ingest/semaphore";
import type { SemaphoreResult } from "@/lib/push-ingest/types";
import { useSettings } from "./use-settings";

const supabase = createClient();

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
 * - Reads ceiling from user_settings (DB), fallback to env var, then 0 (disabled)
 * - Queries current month's variable expenses (is_payment=false, expense_type='variable')
 * - Computes semaphore state
 * - Returns semaphore result + rolling daily budget, or null if no ceiling configured
 */
export function useSemaphore() {
  const { data: settings, isLoading: settingsLoading } = useSettings();

  // Read ceiling from user settings (DB), fallback to env var, then 0 (disabled)
  const ceiling = settings?.budget_ceiling_usd ?? null;

  return useQuery<SemaphoreData | null>({
    queryKey: ["semaphore", "current-month", ceiling],
    queryFn: async (): Promise<SemaphoreData | null> => {
      // No ceiling configured → return null to signal "not configured"
      if (ceiling === null || ceiling <= 0) return null;

      const { start, end } = getCurrentMonthRange();
      const { currentDay, daysInMonth } = getMonthInfo();

      // Query accumulated variable expenses for current month
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
        ceiling,
        current_day: currentDay,
        days_in_month: daysInMonth,
      });

      // Rolling daily budget: (ceiling - spent) / remaining days
      const remainingDays = daysInMonth - currentDay + 1; // include today
      const dailyBudget =
        remainingDays > 0
          ? Math.max(0, (ceiling - accumulatedSpend) / remainingDays)
          : 0;

      return {
        ...semaphore,
        daily_budget: Math.round(dailyBudget * 100) / 100,
      };
    },
    enabled: !settingsLoading,
  });
}
