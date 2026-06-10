/** Transacción candidata normalizada de cualquier fuente */
export interface CandidateTransaction {
  amount_native: number;
  native_currency: string; // "COP" | "USD"
  fx_rate_to_usd?: number; // pre-filled for USD sources
  amount_usd?: number; // pre-filled for USD sources
  merchant: string | null;
  tx_date: string; // YYYY-MM-DD
  description_raw: string;
  account_name: string; // "Bancolombia" | "Nexo Card"
  source: SyncSource;
}

export type SyncSource = "sync_bancolombia" | "sync_nexo";

/** Resultado de dedup para una candidata individual */
export type DedupDecision =
  | { action: "insert" }
  | { action: "insert_review"; reason: string }
  | { action: "discard"; reason: string };

/** Resultado de sincronización por fuente */
export interface SyncSourceResult {
  source: SyncSource;
  found: number;
  inserted: number;
  duplicates: number;
  needs_review: number;
  errors: string[];
}

/** Request body del Route Handler */
export interface SyncRequest {
  month: string; // "YYYY-MM"
}

/** Response body consolidada */
export interface SyncResponse {
  result: SyncSourceResult;
}

/** Error codes del sync */
export type SyncErrorCode =
  | "AUTH_EXPIRED"
  | "MCP_ERROR"
  | "FX_ERROR"
  | "DB_ERROR"
  | "TIMEOUT";

/** Error response */
export interface SyncErrorResponse {
  error: string;
  code: SyncErrorCode;
}

/** Parámetros del sync desde el cliente */
export interface SyncParams {
  month: string;
  sources: SyncSource[];
}

/** Estado de progreso en el cliente */
export interface SyncProgress {
  current_source: SyncSource | null;
  completed: SyncSourceResult[];
  errors: Array<{ source: SyncSource; error: string }>;
  status: "idle" | "running" | "done";
}

/** Mensajes de error para el usuario (en español) */
export const ERROR_MESSAGES: Record<SyncErrorCode, string> = {
  AUTH_EXPIRED:
    "La sesión bancaria expiró. Abrí Bancolombia/Nexo en el navegador y volvé a intentar.",
  MCP_ERROR:
    "Error al consultar la fuente. Intentá de nuevo en unos minutos.",
  TIMEOUT: "La consulta tardó demasiado. Intentá de nuevo.",
  FX_ERROR:
    "No se pudo obtener la tasa de cambio. Algunas transacciones no se procesaron.",
  DB_ERROR: "Error al guardar las transacciones. Intentá de nuevo.",
};
