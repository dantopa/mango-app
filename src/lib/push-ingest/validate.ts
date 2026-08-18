import { isKnownCurrency } from "./money";
import type { ParsedTransaction } from "./types";

/**
 * Last gate before a parsed notification becomes a row in `transactions`.
 *
 * Whatever produced the extraction — a hand-written parser, a learned template
 * or an LLM — has to clear the same checks. This is the only reason to trust an
 * AI-authored template: nothing it produces reaches the database without being
 * re-derived and re-checked by deterministic code.
 */

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/**
 * A parsed transaction whose currency has already been resolved against the
 * account. The pipeline must resolve it before validating — a bare "$" is not
 * something this gate can guess.
 */
export type ResolvedTransaction = Omit<ParsedTransaction, "native_currency"> & { native_currency: string };

/** A single notification above this is a parsing error, not a purchase. */
const MAX_ABSOLUTE_AMOUNT = 1_000_000_000;

const MAX_MERCHANT_LENGTH = 200;

export type ValidationOptions = {
  /** Today in YYYY-MM-DD, in the user's timezone. */
  today: string;
  /** How far back a transaction may be dated. Widened when reprocessing old raw logs. */
  maxPastDays?: number;
  /** Tolerance for a device clock running ahead. */
  maxFutureDays?: number;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Days between two YYYY-MM-DD dates (b - a), or null if either is not a real date. */
function daysBetween(a: string, b: string): number | null {
  const aMs = Date.parse(`${a}T00:00:00Z`);
  const bMs = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) return null;
  return Math.round((bMs - aMs) / 86_400_000);
}

/** True if the string is a calendar date that exists (rejects 2026-02-31). */
function isRealDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateParsedTransaction(
  parsed: ResolvedTransaction,
  options: ValidationOptions,
): ValidationResult {
  const { today, maxPastDays = 60, maxFutureDays = 2 } = options;
  const errors: string[] = [];

  if (!Number.isFinite(parsed.amount_native)) {
    errors.push(`amount_native is not a number: ${parsed.amount_native}`);
  } else if (parsed.amount_native === 0) {
    // Declined-purchase notifications carry a 0 amount; they are not expenses.
    errors.push("amount_native is 0");
  } else if (Math.abs(parsed.amount_native) > MAX_ABSOLUTE_AMOUNT) {
    errors.push(`amount_native out of range: ${parsed.amount_native}`);
  }

  if (!isKnownCurrency(parsed.native_currency)) {
    errors.push(`unknown currency: ${parsed.native_currency}`);
  }

  if (!isRealDate(parsed.tx_date)) {
    errors.push(`tx_date is not a valid YYYY-MM-DD date: ${parsed.tx_date}`);
  } else {
    const age = daysBetween(parsed.tx_date, today);
    if (age === null) {
      errors.push(`cannot compare tx_date ${parsed.tx_date} against today ${today}`);
    } else if (age > maxPastDays) {
      errors.push(`tx_date ${parsed.tx_date} is ${age} days old (limit ${maxPastDays})`);
    } else if (age < -maxFutureDays) {
      errors.push(`tx_date ${parsed.tx_date} is in the future`);
    }
  }

  if (parsed.description_raw.trim() === "") {
    errors.push("description_raw is empty");
  }

  if (parsed.merchant !== null && parsed.merchant.length > MAX_MERCHANT_LENGTH) {
    errors.push(`merchant is longer than ${MAX_MERCHANT_LENGTH} characters`);
  }

  if (parsed.card_last4 != null && !/^\d{4}$/.test(parsed.card_last4)) {
    errors.push(`card_last4 is not 4 digits: ${parsed.card_last4}`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
