import { z } from "zod";

const epochOrIso = z.union([
  z.number().positive(), // epoch ms
  z.string().datetime(), // ISO 8601
]);

/**
 * Schema para el payload del Android Notification Forwarder.
 * Acepta `timestamp` o `postedAt` (el forwarder real manda `postedAt`).
 * Campos extras se ignoran con passthrough.
 */
export const pushPayloadSchema = z
  .object({
    packageName: z.string().min(1),
    title: z.string(),
    text: z.string(),
    // El forwarder manda postedAt, no timestamp
    timestamp: epochOrIso.optional(),
    postedAt: epochOrIso.optional(),
    // Campos opcionales del forwarder
    postTime: z.number().int().optional(),
    key: z.string().optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
    appName: z.string().optional(),
    deviceId: z.string().optional(),
    notificationKey: z.string().optional(),
  })
  .passthrough()
  .refine((data) => data.timestamp != null || data.postedAt != null, {
    message: "Either timestamp or postedAt must be provided",
  })
  .transform((data) => ({
    packageName: data.packageName,
    title: data.title,
    text: data.text,
    // Normalize: use timestamp if present, fallback to postedAt
    timestamp: data.timestamp ?? data.postedAt!,
    postTime: data.postTime,
    key: data.key,
    extras: data.extras,
  }));

export type PushPayloadInput = z.output<typeof pushPayloadSchema>;

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
