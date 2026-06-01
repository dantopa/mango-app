import type { Tables } from "./supabase/database.types";

export type Account = Tables<"accounts">;
export type Category = Tables<"categories">;
export type Goal = Tables<"goals">;
export type NetWorthSnapshot = Tables<"net_worth_snapshots">;
export type Transaction = Tables<"transactions">;

/** Transaction joined with its account + category (the shape the UI consumes). */
export type TransactionWithRelations = Transaction & {
  account: Pick<Account, "id" | "name" | "type"> | null;
  category: Pick<Category, "id" | "name" | "color"> | null;
};

export type AccountType = Account["type"];
