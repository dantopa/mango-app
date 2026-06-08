import { z } from "zod";

/** Schema estricto para el payload del Android Notification Forwarder */
export const pushPayloadSchema = z.object({
  packageName: z.string().min(1),
  title: z.string(),
  text: z.string(),
  timestamp: z.union([
    z.number().int().positive(), // epoch ms
    z.string().datetime(), // ISO 8601
  ]),
  // Campos opcionales del forwarder
  postTime: z.number().int().optional(),
  key: z.string().optional(),
  extras: z.record(z.string(), z.unknown()).optional(),
});

export type PushPayloadInput = z.infer<typeof pushPayloadSchema>;

/** Schema para la respuesta del endpoint (discriminated union on "status") */
export const pushResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("logged") }),
  z.object({ status: z.literal("duplicate"), dedup_key: z.string() }),
  z.object({ status: z.literal("no_parser"), package_name: z.string() }),
  z.object({ status: z.literal("registered"), transaction_id: z.string() }),
  z.object({ status: z.literal("fx_pending"), dedup_key: z.string() }),
  z.object({ status: z.literal("deduped_cross_source"), kept_key: z.string() }),
  z.object({ status: z.literal("registration_failed"), error: z.string() }),
]);
