import type { Tables } from "./supabase/database.types";

export type Account = Tables<"accounts">;
export type Category = Tables<"categories">;
export type Goal = Tables<"goals">;
export type NetWorthSnapshot = Tables<"net_worth_snapshots">;
export type Transaction = Tables<"transactions">;
export type MonthlyClose = Tables<"monthly_close">;
export type MonthlyCloseItem = Tables<"monthly_close_items">;

/** Transaction joined with its account + category (the shape the UI consumes). */
export type TransactionWithRelations = Transaction & {
  account: Pick<Account, "id" | "name" | "type"> | null;
  category: Pick<Category, "id" | "name" | "color"> | null;
};

/** A monthly close with its checklist items. */
export type MonthlyCloseWithItems = MonthlyClose & {
  items: MonthlyCloseItem[];
};

export type AccountType = Account["type"];
