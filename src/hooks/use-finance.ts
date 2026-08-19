"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PostgrestError } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import type {
  Account,
  Category,
  Goal,
  MonthlyCloseWithItems,
  NetWorthSnapshot,
  TransactionWithRelations,
} from "@/lib/types";
import type { GoalFormValues, TransactionEditValues } from "@/lib/schemas";
import { extractPattern, isUsablePattern } from "@/lib/push-ingest/pattern";

const supabase = createClient();

export const queryKeys = {
  accounts: ["accounts"] as const,
  categories: ["categories"] as const,
  snapshots: ["snapshots"] as const,
  transactions: ["transactions"] as const,
  goals: ["goals"] as const,
  monthlyCloses: ["monthly_closes"] as const,
};

/** The fixed source catalog seeded into every new monthly close. */
export const DEFAULT_CLOSE_SOURCES: { source: string; item_type: string }[] = [
  { source: "RappiCard", item_type: "extracto_pdf" },
  { source: "BBVA Visa", item_type: "extracto_pdf" },
  { source: "BBVA Mastercard", item_type: "extracto_pdf" },
  { source: "Bancolombia", item_type: "gmail_auto" },
  { source: "Arriendo", item_type: "gmail_auto" },
  { source: "Nexo saldo", item_type: "saldo" },
  { source: "IBKR saldo", item_type: "saldo" },
  { source: "Wise saldo", item_type: "saldo" },
];

/**
 * PostgREST truncates every response at `max_rows` (1000 on this project) and
 * says nothing about it, so an unpaged select silently starts dropping the
 * oldest rows once the table crosses that size — every total on every screen
 * would then be wrong with no error to notice.
 */
const PAGE_SIZE = 1000;

type Page<T> = PromiseLike<{ data: T[] | null; error: PostgrestError | null }>;

/** Reads every row by ranges. The page query must have a unique tiebreaker sort. */
async function fetchAllPages<T>(page: (from: number, to: number) => Page<T>): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return all;
}

export function useAccounts() {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: async (): Promise<Account[]> => {
      const { data, error } = await supabase
        .from("accounts")
        .select("*")
        .order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function useCategories() {
  return useQuery({
    queryKey: queryKeys.categories,
    queryFn: async (): Promise<Category[]> => {
      const { data, error } = await supabase
        .from("categories")
        .select("*")
        .order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function useSnapshots() {
  return useQuery({
    queryKey: queryKeys.snapshots,
    queryFn: (): Promise<NetWorthSnapshot[]> =>
      fetchAllPages((from, to) =>
        supabase
          .from("net_worth_snapshots")
          .select("*")
          .order("snapshot_date")
          .order("id")
          .range(from, to),
      ),
  });
}

export function useTransactions() {
  return useQuery({
    queryKey: queryKeys.transactions,
    queryFn: async (): Promise<TransactionWithRelations[]> => {
      const rows = await fetchAllPages((from, to) =>
        supabase
          .from("transactions")
          .select("*, account:accounts(id,name,type), category:categories(id,name,color)")
          // `tx_date` repeats heavily, and ranges over a non-deterministic sort
          // skip and duplicate rows, so `id` breaks the ties.
          .order("tx_date", { ascending: false })
          .order("id")
          .range(from, to),
      );
      return rows as unknown as TransactionWithRelations[];
    },
  });
}

export function useGoals() {
  return useQuery({
    queryKey: queryKeys.goals,
    queryFn: async (): Promise<Goal[]> => {
      const { data, error } = await supabase
        .from("goals")
        .select("*")
        .order("target_date");
      if (error) throw error;
      return data;
    },
  });
}

export function useUpdateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      values,
    }: {
      id: string;
      values: Partial<TransactionEditValues>;
    }) => {
      const { error } = await supabase.from("transactions").update(values).eq("id", id);
      if (error) throw error;

      if (values.category_id) await learnCategoryRule(id, values.category_id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.transactions }),
  });
}

/**
 * Turn a manual re-categorization into a rule, so the same merchant never comes
 * back asking again. This is the counterpart of the AI's own rule writing: same
 * table, but priority 0 instead of -10, so a correction always outranks whatever
 * the model had guessed.
 *
 * Best-effort by design — the transaction is already saved, and failing to learn
 * from it is not worth surfacing an error over.
 */
async function learnCategoryRule(txId: string, categoryId: string): Promise<void> {
  const { data: tx } = await supabase
    .from("transactions")
    .select("user_id, merchant")
    .eq("id", txId)
    .single();

  // No merchant means the counterparty is buried in the raw text, and picking it
  // out is the AI's job, not a guess made here.
  if (!tx?.merchant) return;

  const pattern = extractPattern(tx.merchant);
  if (!pattern || !isUsablePattern(pattern, tx.merchant)) return;

  const { data: existing } = await supabase
    .from("merchant_category_rules")
    .select("id")
    .eq("user_id", tx.user_id)
    .eq("pattern", pattern)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("merchant_category_rules")
      .update({ category_id: categoryId, priority: 0 })
      .eq("id", existing.id);
    return;
  }

  await supabase.from("merchant_category_rules").insert({
    user_id: tx.user_id,
    pattern,
    match_type: "ilike",
    category_id: categoryId,
    priority: 0,
  });
}

export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("transactions").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.transactions }),
  });
}

async function getUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("No hay sesión activa");
  return data.user.id;
}

export function useUpsertGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id?: string; values: GoalFormValues }) => {
      if (id) {
        const { error } = await supabase.from("goals").update(values).eq("id", id);
        if (error) throw error;
      } else {
        const user_id = await getUserId();
        const { error } = await supabase.from("goals").insert({ ...values, user_id });
        if (error) throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.goals }),
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("goals").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.goals }),
  });
}

// ---------------------------------------------------------------------------
// Monthly close
// ---------------------------------------------------------------------------

export function useMonthlyCloses() {
  return useQuery({
    queryKey: queryKeys.monthlyCloses,
    queryFn: async (): Promise<MonthlyCloseWithItems[]> => {
      const { data, error } = await supabase
        .from("monthly_close")
        .select("*, items:monthly_close_items(*)")
        .order("period", { ascending: false });
      if (error) throw error;
      // Stable ordering of the checklist (insertion order via created_at).
      return (data as unknown as MonthlyCloseWithItems[]).map((c) => ({
        ...c,
        items: [...c.items].sort((a, b) => a.created_at.localeCompare(b.created_at)),
      }));
    },
  });
}

/** Creates the close for a period and seeds the default source checklist. */
export function useCreateMonthlyClose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (period: string) => {
      const user_id = await getUserId();
      const { data: close, error } = await supabase
        .from("monthly_close")
        .insert({ period, user_id, status: "en_progreso" })
        .select()
        .single();
      if (error) throw error;

      const items = DEFAULT_CLOSE_SOURCES.map((s) => ({
        ...s,
        close_id: close.id,
        user_id,
      }));
      const { error: itemsError } = await supabase
        .from("monthly_close_items")
        .insert(items);
      if (itemsError) throw itemsError;
      return close;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.monthlyCloses }),
  });
}

export function useUpdateCloseItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase
        .from("monthly_close_items")
        .update({
          status,
          loaded_at: status === "cargado" ? new Date().toISOString() : null,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.monthlyCloses }),
  });
}

export function useUpdateClose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      values,
    }: {
      id: string;
      values: Partial<{
        status: string;
        closed_at: string | null;
        net_worth_usd: number | null;
        total_spend_usd: number | null;
        savings_usd: number | null;
        notes: string | null;
      }>;
    }) => {
      const { error } = await supabase.from("monthly_close").update(values).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.monthlyCloses }),
  });
}
