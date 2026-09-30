/**
 * Lifecycle of a transaction row. Nothing is ever deleted: a row the reconciler
 * rules out keeps its data and says why, so every decision can be audited and
 * reverted.
 *
 * Only `active` rows count toward spend, income, the monthly close and the
 * budget semaphore.
 */
export const TX_STATUSES = ["active", "duplicate", "voided", "internal_transfer"] as const;
export type TxStatus = (typeof TX_STATUSES)[number];

/** The rule behind a status change, as stored in `status_reason` and the reconcile log. */
export type ReconcileRule =
  /** Same purchase notified more than once (issuer + Wallet, or a re-posted notification). */
  | "duplicate_notification"
  /** A pre-authorization and its release: both cancel out. */
  | "preauth_released"
  /** A pre-authorization replaced by the provider's final charge, with no release notified. */
  | "preauth_superseded"
  /** Money moved between two of the owner's own accounts. */
  | "internal_transfer"
  /** A previous automatic decision no longer holds. */
  | "restored";

/** The columns reconciliation reads from `transactions`. */
export interface ReconcileRow {
  id: string;
  account_id: string;
  tx_date: string; // YYYY-MM-DD
  merchant: string | null;
  description_raw: string | null;
  amount_native: number;
  native_currency: string;
  amount_usd: number;
  is_payment: boolean;
  source: string;
  /**
   * The notifier that produced the row: the Android package for push ingests
   * (from push_ingest_log), otherwise the sync source.
   */
  origin: string | null;
  external_ts: string | null;
  created_at: string;
  needs_review: boolean;
  status: TxStatus;
  duplicate_of: string | null;
  paired_with: string | null;
  status_reason: string | null;
  /** Set when a person decided the status; reconciliation never overrides it. */
  status_manual: boolean;
}

export type RowState = {
  status: TxStatus;
  duplicate_of: string | null;
  paired_with: string | null;
  status_reason: string | null;
};

export interface StatusChange {
  id: string;
  from: RowState;
  to: RowState;
  rule: ReconcileRule;
  /** The row this decision was made against (canonical purchase, paired charge…). */
  ref_id: string | null;
  /** Human-readable explanation for logs and the dry-run report. */
  detail: string;
}

export interface ReviewFlag {
  id: string;
  detail: string;
}

export interface ReconcileResult {
  changes: StatusChange[];
  /** Rows that stay active but deserve a human look (set `needs_review`). */
  reviewFlags: ReviewFlag[];
}
