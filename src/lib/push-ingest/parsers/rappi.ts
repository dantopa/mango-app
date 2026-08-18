import type { ParseResult, ParserFn, PushPayload } from "../types";
import { resolveTxDate } from "../dates";
import { parseAmount } from "../money";

/**
 * Rappi / RappiCard push notification parser.
 * Handles: "Tu compra en {MERCHANT} por $ {AMOUNT} fue exitosa"
 * Ignores: delivery notifications, promos and rating requests — Rappi is by far
 * the noisiest package in push_raw_log (~170 of ~600 notifications), and every
 * one of those used to be a candidate for a paid LLM call.
 */

// RappiCard purchase pattern
const RE_COMPRA = /tu compra en (.+?) por \$ ?([\d.,]+) fue exitosa/i;

// Non-financial notifications: delivery tracking, promos, surveys, loyalty.
// `pedido.{0,20}` covers both "pedido entregado" and "pedido ha sido cancelado".
const RE_NOT_FINANCIAL =
  /pedido.{0,20}(entregad|cancelad|confirmad)|en camino|ya casi llega|alístate|llegó.*pedido|calific|antojo|millas|cupón|restaurante esta preparando|foto de tu pedido/i;

export const rappiParser: ParserFn = (payload: PushPayload): ParseResult => {
  const { title, text } = payload;

  if (RE_NOT_FINANCIAL.test(text) || RE_NOT_FINANCIAL.test(title)) {
    return { kind: "ignore", reason: "delivery or promotional notification" };
  }

  const match = text.match(RE_COMPRA);
  if (!match) return { kind: "unknown" };

  const amount = parseAmount(match[2], "COP");
  if (amount === null || amount <= 0) return { kind: "unknown" };

  return {
    kind: "transaction",
    tx: {
      amount_native: amount,
      native_currency: "COP",
      merchant: match[1].trim(),
      tx_date: resolveTxDate(payload.timestamp),
      description_raw: text,
      account_name: "Rappi",
    },
  };
};
