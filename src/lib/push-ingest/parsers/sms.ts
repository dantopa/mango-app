import type { ParsedTransaction, ParserFn, PushPayload } from "../types";
import { bancolombiaParser } from "./bancolombia";
import { rappiParser } from "./rappi";
import { nexoParser } from "./nexo";
import { bbvaArgentinaParser } from "./bbva-argentina";

/**
 * SMS "meta-parser": when a notification comes from a generic messaging app
 * (Google Messages, Samsung Messages, etc.), we try each financial parser
 * by content. First match wins.
 *
 * This handles cases where banks send SMS notifications instead of (or in
 * addition to) push notifications from their own app.
 */
const financialParsers: ParserFn[] = [
  bancolombiaParser,
  rappiParser,
  bbvaArgentinaParser,
  nexoParser,
];

export const smsParser: ParserFn = (payload: PushPayload): ParsedTransaction | null => {
  for (const parser of financialParsers) {
    const result = parser(payload);
    if (result) return result;
  }
  return null;
};
