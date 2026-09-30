/**
 * Transfers between the owner's own accounts.
 *
 * "Bancolombia: PATRICIO, transferiste $1,000,000.00 a la llave … a PATRICIO
 * EDUARDO DANDREA ESCODA" is money moving between two of the owner's pockets:
 * neither an expense nor income. It used to land in "Varios" as a 1M COP spend.
 *
 * Only the counterparty of a transfer is compared. The owner's full name also
 * appears in every RappiCard email greeting ("¡Hola, PATRICIO EDUARDO …!"), so
 * a plain "text contains the owner's name" check would turn every card purchase
 * into a transfer.
 */

export type OwnerIdentity = {
  /** Full names the owner's accounts are registered under. */
  names: readonly string[];
  /** Transfer keys (llaves) and account numbers the owner controls. */
  keys: readonly string[];
};

/** Only these texts describe a transfer; anything else is never internal. */
const RE_TRANSFER = /transferiste|recibiste\s+(?:una\s+transferencia|un\s+pago)|transferencia\s+de/i;

/** Sender of incoming money: "recibiste una transferencia de NAME por $85,000". */
const RE_SENDER = /recibiste\s+(?:una\s+transferencia|un\s+pago)\s+de\s+(.+?)\s+(?:por|en)\s+\$/i;

/**
 * Recipient of outgoing money. Bancolombia names them last, just before the
 * timestamp: "… a la llave 3007570391 desde tu cuenta *9898 a NAME el 21/08/26".
 */
const RE_RECIPIENT = /\sa\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ.\s]+?)\s+el\s+\d{1,2}\/\d{1,2}/;

/**
 * Destination key or account: "a la llave 3007570391", "a la llave @dahyna181",
 * "a la cuenta *3105874789". The source account ("desde tu cuenta *9898") is
 * deliberately not matched.
 */
const RE_DESTINATION_KEY = /\ba\s+la\s+(?:llave|cuenta)\s+\*?(@?[\w.+-]+)/gi;

function normalizeName(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeKey(value: string): string {
  return value.trim().replace(/^[@*]/, "").toLowerCase();
}

/**
 * A counterparty is the owner when one name's words are all part of the other,
 * and the shorter has at least two words: banks truncate long names
 * ("PATRICIO EDUARDO DANDREA"), but a lone first name proves nothing.
 */
function isOwnerName(counterparty: string, ownerNames: readonly string[]): boolean {
  const tokens = normalizeName(counterparty);
  return ownerNames.some((owner) => {
    const ownerTokens = normalizeName(owner);
    const [shorter, longer] =
      tokens.length <= ownerTokens.length ? [tokens, ownerTokens] : [ownerTokens, tokens];
    return shorter.length >= 2 && shorter.every((t) => longer.includes(t));
  });
}

export type InternalTransferMatch = { via: "name" | "key"; value: string };

/**
 * Returns how a transfer was recognized as internal, or null when it is not one
 * (or not a transfer at all).
 */
export function matchInternalTransfer(
  row: { merchant: string | null; description_raw: string | null },
  identity: OwnerIdentity,
): InternalTransferMatch | null {
  const text = row.description_raw ?? "";
  if (!RE_TRANSFER.test(text)) return null;

  if (identity.keys.length > 0) {
    const ownKeys = new Set(identity.keys.map(normalizeKey));
    for (const match of text.matchAll(RE_DESTINATION_KEY)) {
      if (ownKeys.has(normalizeKey(match[1]))) return { via: "key", value: match[1] };
    }
  }

  if (identity.names.length > 0) {
    const counterparties = [
      text.match(RE_SENDER)?.[1],
      text.match(RE_RECIPIENT)?.[1],
      row.merchant ?? undefined,
    ].filter((c): c is string => Boolean(c?.trim()));

    const owner = counterparties.find((c) => isOwnerName(c, identity.names));
    if (owner) return { via: "name", value: owner.trim() };
  }

  return null;
}
