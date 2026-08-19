/** Payload crudo del Android Notification Forwarder */
export type PushPayload = {
  packageName: string;
  title: string;
  text: string;
  timestamp: number | string; // epoch ms or ISO string
  postTime?: number;
  key?: string;
  extras?: Record<string, unknown>;
};

/** Resultado de un parser exitoso */
export type ParsedTransaction = {
  /** Positivo = gasto, negativo = devolución. */
  amount_native: number;
  /**
   * "COP" | "USD" | "USDT" | etc. `null` cuando la notificación usa un "$" sin
   * código: el mismo símbolo es COP en la tarjeta de Rappi y USD en la de Nexo,
   * así que lo resuelve el pipeline con la moneda de la cuenta.
   */
  native_currency: string | null;
  merchant: string | null;
  tx_date: string; // YYYY-MM-DD
  description_raw: string;
  account_name: string;
  card_last4?: string | null; // últimos 4 dígitos de la tarjeta — clave de dedup
  /**
   * Plata que entra (transferencia o pago recibido), con `amount_native` negativo.
   * Explícito y no derivado del signo: una devolución también es negativa, pero
   * cancela un gasto (`is_payment = true`) en vez de ser un ingreso.
   */
  is_income?: boolean;
};

/**
 * Resultado de un parser.
 *
 * La distinción entre `ignore` y `unknown` es la que faltaba: devolver `null`
 * para "esto es una compra rechazada" era indistinguible de "no entiendo este
 * formato", así que el fallback de IA pisaba rechazos correctos e inventaba
 * gastos (49 de ~55 notificaciones de BBVA eran "Compra rechazada").
 *
 * Sólo `unknown` escala a la IA.
 */
export type ParseResult =
  /** Entendido y hay que registrarlo. `amount_native` negativo = devolución. */
  | { kind: "transaction"; tx: ParsedTransaction }
  /** Entendido y NO hay que registrarlo (rechazo, promo, delivery, ingreso). */
  | { kind: "ignore"; reason: string }
  /** Formato no reconocido: único caso que vale escalar a la IA. */
  | { kind: "unknown" };

/** Tipo de función parser */
export type ParserFn = (payload: PushPayload) => ParseResult;

/** Estado del semáforo */
export type SemaphoreState = "verde" | "amarillo" | "rojo";

/** Resultado del cálculo del semáforo */
export type SemaphoreResult = {
  state: SemaphoreState;
  spent: number; // gasto acumulado del mes (USD)
  ceiling: number; // techo T (USD)
  pct: number; // porcentaje consumido (0-1+)
  expected_pct: number; // porcentaje esperado para el día actual
  day: number; // día del mes actual
  days_in_month: number;
};

/** Resultado del pipeline — discriminated union */
export type PipelineResult =
  | { status: "logged" }
  | { status: "duplicate"; dedup_key: string }
  | { status: "no_parser"; package_name: string }
  | { status: "ignored"; reason: string }
  | { status: "registered"; transaction_id: string; semaphore?: SemaphoreResult }
  | { status: "fx_pending"; dedup_key: string }
  | { status: "deduped_cross_source"; kept_key: string }
  | { status: "registration_failed"; error: string }
  | { status: "pending_confirmation"; dedup_key: string; merchant: string | null; amount: number; currency: string }
  | { status: "deduped_wallet_echo" };

/** Modos de operación */
export type IngestMode = "log_only" | "full_pipeline";

/** Entrada para el cálculo del semáforo (función pura) */
export type SemaphoreInput = {
  accumulated_spend: number; // gasto acumulado del mes en USD
  ceiling: number; // techo T en USD
  current_day: number; // día actual del mes (1-based)
  days_in_month: number; // total de días del mes
};
