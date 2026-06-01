"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import type {
  Account,
  Category,
  Goal,
  NetWorthSnapshot,
  TransactionWithRelations,
} from "@/lib/types";
import type { GoalFormValues, TransactionEditValues } from "@/lib/schemas";

const supabase = createClient();

export const queryKeys = {
  accounts: ["accounts"] as const,
  categories: ["categories"] as const,
  snapshots: ["snapshots"] as const,
  transactions: ["transactions"] as const,
  goals: ["goals"] as const,
};

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
    queryFn: async (): Promise<NetWorthSnapshot[]> => {
      const { data, error } = await supabase
        .from("net_worth_snapshots")
        .select("*")
        .order("snapshot_date");
      if (error) throw error;
      return data;
    },
  });
}

export function useTransactions() {
  return useQuery({
    queryKey: queryKeys.transactions,
    queryFn: async (): Promise<TransactionWithRelations[]> => {
      const { data, error } = await supabase
        .from("transactions")
        .select(
          "*, account:accounts(id,name,type), category:categories(id,name,color)",
        )
        .order("tx_date", { ascending: false });
      if (error) throw error;
      return data as unknown as TransactionWithRelations[];
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
