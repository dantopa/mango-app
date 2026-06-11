/** Transacción candidata normalizada de cualquier fuente */
export interface CandidateTransaction {
  amount_native: number;
  native_currency: string; // "COP" | "USD" | "ARS"
  fx_rate_to_usd?: number; // pre-filled for USD sources
  amount_usd?: number; // pre-filled for USD sources
  merchant: string | null;
  tx_date: string; // YYYY-MM-DD
  description_raw: string;
  account_name: string; // "Bancolombia" | "Nexo Card" | "BBVA Visa" | "BBVA Mastercard"
  source: SyncSource;
  expense_type?: "fixed" | "variable"; // defaults to "variable" if not set
  card_last4?: string | null; // últimos 4 dígitos de la tarjeta (*5685, ••5685) — clave fuerte de dedup
  country?: string; // ISO 3166-1 alpha-2 (defaults to "CO" if not set)
}

export type SyncSource =
  | "sync_bancolombia"
  | "sync_nexo"
  | "sync_bbva"
  | "sync_gmail_bancolombia"
  | "sync_gmail_rappicard"
  | "sync_gmail_arriendo"
  | "sync_notifications";

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
  | "TIMEOUT"
  | "GMAIL_AUTH_REQUIRED"
  | "GMAIL_API_ERROR";

/** Error response */
export interface SyncErrorResponse {
  error: string;
  code: SyncErrorCode;
}

/** Fuentes visibles desde el cliente (incluye "sync_gmail" como grupo) */
export type ClientSyncSource = SyncSource | "sync_gmail" | "sync_notifications";

/** Parámetros del sync desde el cliente */
export interface SyncParams {
  month: string;
  sources: ClientSyncSource[];
}

/** Estado de progreso en el cliente */
export interface SyncProgress {
  current_source: ClientSyncSource | null;
  completed: SyncSourceResult[];
  errors: Array<{ source: ClientSyncSource; error: string }>;
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
  GMAIL_AUTH_REQUIRED:
    "Gmail no está conectado. Conectá tu cuenta para sincronizar.",
  GMAIL_API_ERROR:
    "Error al consultar Gmail. Intentá de nuevo en unos minutos.",
};
