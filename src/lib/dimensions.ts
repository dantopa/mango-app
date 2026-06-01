/**
 * Catalog of the expense dimensions added in v2 (country / payment_type /
 * expense_type). Single source of truth for the enum values, their Spanish
 * labels and chart colors — shared by the filters and the charts so they never
 * drift apart. These mirror the `text` enums documented in
 * supabase/migrations/0003_expense_dimensions.sql.
 */

export type Country = "AR" | "CO" | "US" | "global";
export type PaymentType =
  | "credito"
  | "debito"
  | "transferencia"
  | "pse_qr"
  | "efectivo"
  | "inversion"
  | "wallet";
export type ExpenseType = "fijo" | "variable" | "extraordinario";

type Option<T extends string> = { value: T; label: string; color: string };

export const COUNTRIES: Option<Country>[] = [
  { value: "AR", label: "Argentina", color: "#38bdf8" },
  { value: "CO", label: "Colombia", color: "#f59e0b" },
  { value: "US", label: "EE.UU.", color: "#22c55e" },
  { value: "global", label: "Global", color: "#8b5cf6" },
];

export const PAYMENT_TYPES: Option<PaymentType>[] = [
  { value: "credito", label: "Crédito", color: "#ef4444" },
  { value: "debito", label: "Débito", color: "#3b82f6" },
  { value: "transferencia", label: "Transferencia", color: "#06b6d4" },
  { value: "pse_qr", label: "PSE / QR", color: "#14b8a6" },
  { value: "efectivo", label: "Efectivo", color: "#22c55e" },
  { value: "inversion", label: "Inversión", color: "#a855f7" },
  { value: "wallet", label: "Wallet", color: "#eab308" },
];

export const EXPENSE_TYPES: Option<ExpenseType>[] = [
  { value: "fijo", label: "Fijo", color: "#3b82f6" },
  { value: "variable", label: "Variable", color: "#f59e0b" },
  { value: "extraordinario", label: "Extraordinario", color: "#a855f7" },
];

function lookup<T extends string>(opts: Option<T>[]) {
  const byValue = new Map(opts.map((o) => [o.value, o]));
  return {
    label: (v: string | null | undefined) =>
      (v && byValue.get(v as T)?.label) || v || "—",
    color: (v: string | null | undefined) =>
      (v && byValue.get(v as T)?.color) || "#52525b",
  };
}

export const countryMeta = lookup(COUNTRIES);
export const paymentMeta = lookup(PAYMENT_TYPES);
export const expenseTypeMeta = lookup(EXPENSE_TYPES);
