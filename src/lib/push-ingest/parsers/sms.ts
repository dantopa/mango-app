import type { ParseResult, ParserFn, PushPayload } from "../types";
import { bancolombiaParser } from "./bancolombia";
import { rappiParser } from "./rappi";
import { nexoParser } from "./nexo";
import { bbvaArgentinaParser } from "./bbva-argentina";

/**
 * SMS "meta-parser": when a notification comes from a generic messaging app
 * (Google Messages, Samsung Messages, etc.), we try each financial parser by
 * content, because banks send SMS alerts as well as their own push.
 *
 * A transaction wins outright. Otherwise an explicit `ignore` from any parser
 * is preserved — if a parser recognized the SMS as a declined purchase, that is
 * a real answer and must not be downgraded to "unknown" and sent to the LLM.
 * Only a text nobody recognized escalates.
 */
const financialParsers: ParserFn[] = [
  bancolombiaParser,
  rappiParser,
  bbvaArgentinaParser,
  nexoParser,
];

export const smsParser: ParserFn = (payload: PushPayload): ParseResult => {
  let ignored: ParseResult | null = null;

  for (const parser of financialParsers) {
    const result = parser(payload);
    if (result.kind === "transaction") return result;
    if (result.kind === "ignore" && ignored === null) ignored = result;
  }

  return ignored ?? { kind: "unknown" };
};
