/**
 * Resolves a notification to one of the user's accounts.
 *
 * The old pipeline compared the parsed account name to `accounts.name` with a
 * lowercase equality check, so anything the source phrased differently failed:
 * 172 of 609 ingests died on "Account not found" for names like
 * "Mastercard Nexo Card ••4186" when the account is called "Nexo Card".
 *
 * Card digits are the reliable key — they come straight from the notification
 * and are stable per card — so they win over any name matching. Name matching
 * only ever accepts a single unambiguous winner; a tie is an error, never a
 * coin flip, because picking the wrong account silently misfiles money.
 */

export type AccountCandidate = {
  id: string;
  name: string;
  native_currency: string;
  card_digits: string[];
};

export type AccountResolution =
  | { ok: true; account: AccountCandidate; via: "card" | "name" }
  | { ok: false; reason: string };

/**
 * Card markers as banks actually write them: "••4186", "*1886", "****9253",
 * "...5685". Returns the first one found, which in every observed format is the
 * card that was charged.
 */
const RE_CARD_MARKER = /(?:•{1,2}|\*{1,4}|\.{3})\s?(\d{4})(?!\d)/;

/** Last 4 digits of the card named in a notification text, if any. */
export function extractCardLast4(text: string): string | null {
  const match = text.match(RE_CARD_MARKER);
  return match ? match[1] : null;
}

/** Lowercase, unaccented, punctuation collapsed to single spaces. */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Picks the single account whose normalized name matches best under `matches`.
 * Longer account names win (so "BBVA Mastercard" beats "BBVA"); an exact tie
 * between two different accounts is unresolvable.
 */
function uniqueBestMatch(
  candidates: ReadonlyArray<{ account: AccountCandidate; normalized: string }>,
  hint: string,
  matches: (accountName: string, hint: string) => boolean,
): AccountCandidate | "ambiguous" | null {
  const hits = candidates.filter((c) => matches(c.normalized, hint));
  if (hits.length === 0) return null;

  const longest = Math.max(...hits.map((c) => c.normalized.length));
  const best = hits.filter((c) => c.normalized.length === longest);
  return best.length === 1 ? best[0].account : "ambiguous";
}

/**
 * Resolves an account from a card's last 4 digits and/or a free-text name.
 * Card digits are tried first; the name is only a fallback for sources that
 * don't include a card.
 */
export function resolveAccount(
  accounts: readonly AccountCandidate[],
  hints: { cardLast4?: string | null; accountName?: string | null },
): AccountResolution {
  const { cardLast4, accountName } = hints;

  if (cardLast4) {
    const byCard = accounts.filter((a) => a.card_digits.includes(cardLast4));
    if (byCard.length === 1) return { ok: true, account: byCard[0], via: "card" };
    if (byCard.length > 1) {
      return {
        ok: false,
        reason: `Card ••${cardLast4} is mapped to ${byCard.length} accounts: ${byCard.map((a) => a.name).join(", ")}`,
      };
    }
  }

  if (accountName) {
    const hint = normalize(accountName);
    if (hint !== "") {
      // Exact, then whole-token run ("bbva mastercard 1886" ⊃ "bbva mastercard"),
      // then plain substring ("tarjeta negra rappicard co" ⊃ "rappi").
      const strategies: ReadonlyArray<(name: string, h: string) => boolean> = [
        (name, h) => name === h,
        (name, h) => ` ${h} `.includes(` ${name} `),
        (name, h) => h.includes(name),
      ];
      const candidates = accounts.map((account) => ({ account, normalized: normalize(account.name) }));
      for (const matches of strategies) {
        const found = uniqueBestMatch(candidates, hint, matches);
        if (found === "ambiguous") {
          return { ok: false, reason: `Account name "${accountName}" matches more than one account` };
        }
        if (found) return { ok: true, account: found, via: "name" };
      }
    }
  }

  const cardPart = cardLast4 ? `card ••${cardLast4}` : null;
  const namePart = accountName ? `name "${accountName}"` : null;
  const tried = [cardPart, namePart].filter(Boolean).join(" / ") || "no card or name";
  return { ok: false, reason: `Account not found for ${tried}` };
}
