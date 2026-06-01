import { z } from "zod";

/** Validation for the goal create/edit form. */
export const goalSchema = z
  .object({
    name: z.string().min(1, "Poné un nombre"),
    target_usd: z.coerce.number().positive("Tiene que ser mayor a 0"),
    target_date: z.string().min(1, "Elegí una fecha"),
    start_usd: z.coerce.number().min(0, "No puede ser negativo"),
    start_date: z.string().min(1, "Elegí una fecha"),
    is_active: z.boolean(),
  })
  .refine((g) => g.target_date > g.start_date, {
    message: "La fecha objetivo debe ser posterior a la de inicio",
    path: ["target_date"],
  });

export type GoalFormValues = z.infer<typeof goalSchema>;

/** Validation for inline transaction edits from the table. */
export const transactionEditSchema = z.object({
  category_id: z.string().uuid().nullable(),
  is_extraordinary: z.boolean(),
  is_payment: z.boolean(),
  country: z.enum(["AR", "CO", "US", "global"]),
  payment_type: z.enum([
    "credito",
    "debito",
    "transferencia",
    "pse_qr",
    "efectivo",
    "inversion",
    "wallet",
  ]),
  expense_type: z.enum(["fijo", "variable", "extraordinario"]),
});

export type TransactionEditValues = z.infer<typeof transactionEditSchema>;
