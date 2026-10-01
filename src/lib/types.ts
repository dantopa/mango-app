import type { Tables } from "./supabase/database.types";

export type Account = Tables<"accounts">;
export type Category = Tables<"categories">;
export type Goal = Tables<"goals">;
export type NetWorthSnapshot = Tables<"net_worth_snapshots">;
export type Transaction = Tables<"transactions">;
export type MonthlyClose = Tables<"monthly_close">;
export type MonthlyCloseItem = Tables<"monthly_close_items">;

/**
 * Columns the screens read. The list query selects only these: the audit and
 * ingest columns (who reconciled what, raw timestamps, FX snapshot) are never
 * shown, and on every screen load they were a quarter of the payload.
 */
export const TRANSACTION_LIST_COLUMNS = [
  "id",
  "account_id",
  "category_id",
  "tx_date",
  "created_at",
  "description_raw",
  "merchant",
  "amount_native",
  "native_currency",
  "amount_usd",
  "is_payment",
  "is_extraordinary",
  "installments",
  "country",
  "payment_type",
  "expense_type",
  "kind",
  "status",
] as const satisfies readonly (keyof Transaction)[];

export type TransactionListRow = Pick<Transaction, (typeof TRANSACTION_LIST_COLUMNS)[number]>;

/** Transaction joined with its account + category (the shape the UI consumes). */
export type TransactionWithRelations = TransactionListRow & {
  account: Pick<Account, "id" | "name" | "type"> | null;
  category: Pick<Category, "id" | "name" | "color"> | null;
};

/** A monthly close with its checklist items. */
export type MonthlyCloseWithItems = MonthlyClose & {
  items: MonthlyCloseItem[];
};

export type AccountType = Account["type"];
