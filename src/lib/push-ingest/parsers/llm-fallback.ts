import { z } from "zod";

import type { ParseResult, ParsedTransaction, PushPayload } from "../types";
import { extractCardLast4, type AccountCandidate } from "../account-resolver";
import { resolveTxDate } from "../dates";
import { isKnownCurrency, parseAmount } from "../money";
import { PACKAGE_WHITELIST } from "../package-whitelist";
import { getSupabaseAdmin } from "../supabase-admin";

/**
 * Learned parsing: AI structures a format once, deterministic code runs it forever.
 *
 * The rules that make this trustworthy, in order of importance:
 *
 *  1. The AI is only asked about formats no parser recognized (`kind: "unknown"`).
 *     A recognized non-transaction — a declined purchase, a delivery update —
 *     never reaches it. That is what let it invent 49 phantom BBVA expenses.
 *  2. The AI never supplies a number. It quotes the amount as it literally
 *     appears in the notification; we verify the quote exists in the text and
 *     parse it ourselves with `parseAmount`.
 *  3. The AI picks an account from the user's real list or returns null. It
 *     cannot name an account that does not exist.
 *  4. A template is stored only if replaying it through `applyTemplate` — the
 *     same function production uses — over the original notification reproduces
 *     the same extraction. A pattern that cannot parse its own source text is
 *     worthless, and 28 such templates accumulated with zero hits.
 */

/**
 * Cheapest model of the current generation: it wrote a self-verifying pattern for
 * every notification format tried, at roughly a quarter of the price of
 * gpt-5.4-mini. Its parameters are stricter — `temperature` only accepts the
 * default and the cap is `max_completion_tokens`.
 */
const OPENAI_MODEL = "gpt-5.6-luna";
const OPENAI_TIMEOUT_MS = 12_000;

/** Cap on an AI-authored pattern; anything longer is not a notification format. */
const MAX_PATTERN_LENGTH = 400;

/** Nested quantifiers such as `(.+)+` can blow up on adversarial input. */
const RE_NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*]/;

/** An AI-authored pattern must expose the amount as a named group. */
const RE_HAS_AMOUNT_GROUP = /\(\?<amount>/;

/**
 * Pre-filter: some financial packages send tons of marketing/delivery spam.
 * If the deterministic parser already rejected this notification, check if
 * it's actually spam before sending to the expensive LLM fallback.
 */
const PACKAGE_TITLE_REQUIREMENTS: Record<string, RegExp> = {
  // Rappi only sends real purchases with "Compra exitosa" in the title
  "com.grability.rappi": /compra exitosa/i,
};

/** Returns true if the notification should be sent to LLM fallback */
export function shouldTryLlmFallback(packageName: string, title: string): boolean {
  if (!PACKAGE_WHITELIST.has(packageName)) return false;
  const titleRequirement = PACKAGE_TITLE_REQUIREMENTS[packageName];
  if (titleRequirement && !titleRequirement.test(title)) return false;
  return true;
}

// --- Templates ---------------------------------------------------------------

export type TemplateOutcome = "expense" | "refund" | "ignore";

export type ParserTemplate = {
  id: string;
  text_pattern: string;
  title_pattern: string | null;
  amount_group: number | null;
  merchant_group: number | null;
  currency: string;
  account_name: string;
  outcome: TemplateOutcome;
  hit_count: number;
};

const TEMPLATE_COLUMNS =
  "id, text_pattern, title_pattern, amount_group, merchant_group, currency, account_name, outcome, hit_count";

/** Result of executing one template against one notification. */
export type TemplateExtraction =
  | { kind: "transaction"; tx: ParsedTransaction }
  | { kind: "ignore"; reason: string }
  | { kind: "no_match" };

/** Compiles a pattern, rejecting anything unsafe or invalid instead of throwing. */
function compilePattern(pattern: string): RegExp | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return null;
  if (RE_NESTED_QUANTIFIER.test(pattern)) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/**
 * Runs a template over a notification.
 *
 * This is the single implementation of template execution: production reads and
 * the save-time self-test both go through it, so a stored template cannot behave
 * differently from the one that was verified.
 */
export function applyTemplate(template: ParserTemplate, payload: PushPayload): TemplateExtraction {
  if (template.title_pattern !== null) {
    const titleRe = compilePattern(template.title_pattern);
    if (!titleRe || !titleRe.test(payload.title)) return { kind: "no_match" };
  }

  const textRe = compilePattern(template.text_pattern);
  if (!textRe) return { kind: "no_match" };

  const match = payload.text.match(textRe);
  if (!match) return { kind: "no_match" };

  if (template.outcome === "ignore") {
    return { kind: "ignore", reason: `learned template ${template.id}` };
  }

  // Named groups are preferred; positional indexes exist only for hand-written rows.
  const amountRaw = match.groups?.amount ?? (template.amount_group !== null ? match[template.amount_group] : undefined);
  if (amountRaw === undefined) return { kind: "no_match" };

  const amount = parseAmount(amountRaw, template.currency);
  if (amount === null || amount === 0) return { kind: "no_match" };

  const merchantRaw =
    match.groups?.merchant ?? (template.merchant_group !== null ? match[template.merchant_group] : undefined);

  return {
    kind: "transaction",
    tx: {
      // A refund reduces spending, so it is always stored negative.
      amount_native: template.outcome === "refund" ? -Math.abs(amount) : Math.abs(amount),
      native_currency: template.currency,
      merchant: merchantRaw?.trim() ?? null,
      tx_date: resolveTxDate(payload.timestamp),
      description_raw: `${payload.title}: ${payload.text}`,
      account_name: template.account_name,
      card_last4: match.groups?.card ?? extractCardLast4(payload.text),
    },
  };
}

/**
 * Tries every learned template for this package, most-used first.
 * Returns `unknown` when none match, which is the only case worth escalating.
 */
export async function tryTemplateParser(payload: PushPayload, userId: string): Promise<ParseResult> {
  const supabase = getSupabaseAdmin();

  const { data: templates, error } = await supabase
    .from("push_parser_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("user_id", userId)
    .eq("package_name", payload.packageName)
    .order("hit_count", { ascending: false });

  if (error) {
    console.error(`[llm-fallback] template query failed for ${payload.packageName}:`, error.message);
    return { kind: "unknown" };
  }
  if (!templates || templates.length === 0) return { kind: "unknown" };

  for (const template of templates as ParserTemplate[]) {
    const extraction = applyTemplate(template, payload);
    if (extraction.kind === "no_match") continue;

    // hit_count is selected, so the counter actually advances: it used to be
    // omitted from the select and rewritten as (undefined ?? 0) + 1 = 1 forever,
    // which hid the fact that no template had ever matched anything.
    const { error: hitError } = await supabase
      .from("push_parser_templates")
      .update({ hit_count: template.hit_count + 1, last_hit_at: new Date().toISOString() })
      .eq("id", template.id);
    if (hitError) {
      console.error(`[llm-fallback] hit_count update failed for template ${template.id}:`, hitError.message);
    }

    return extraction.kind === "ignore"
      ? { kind: "ignore", reason: extraction.reason }
      : { kind: "transaction", tx: extraction.tx };
  }

  return { kind: "unknown" };
}

// --- LLM fallback ------------------------------------------------------------

/**
 * What the model is allowed to tell us. Every field is a claim to be verified,
 * not a value to be stored — except `merchant`, which is free text either way.
 */
const llmExtractionSchema = z.object({
  understood: z.boolean(),
  is_transaction: z.boolean(),
  is_refund: z.boolean(),
  reason: z.string().max(200),
  /** The amount exactly as it appears in the notification, e.g. "$8.55". */
  amount_text: z.string().max(40).nullable(),
  currency: z.string().max(5).nullable(),
  merchant: z.string().max(200).nullable(),
  /** Must be one of the account names we sent, or null. */
  account_name: z.string().max(120).nullable(),
  /** Regex with a named `amount` group, optionally `merchant` and `card`. */
  text_regex: z.string().max(MAX_PATTERN_LENGTH).nullable(),
});

type LlmExtraction = z.infer<typeof llmExtractionSchema>;

function buildPrompt(payload: PushPayload, accounts: readonly AccountCandidate[], knownPatterns: string[]): string {
  const accountList = accounts
    .map((a) => `- "${a.name}" (${a.native_currency}${a.card_digits.length ? `, cards ${a.card_digits.join("/")}` : ""})`)
    .join("\n");

  const patternList = knownPatterns.length
    ? knownPatterns.map((p) => `- ${p}`).join("\n")
    : "- (none yet)";

  return `You are converting an Android notification into structured data for a personal finance app.

Notification
  package: ${payload.packageName}
  title:   ${payload.title}
  text:    ${payload.text}

The user's accounts (choose account_name from this list EXACTLY, or null):
${accountList}

Patterns already learned for this package (write a NEW pattern only if none of these fit):
${patternList}

Rules — a violation makes the whole answer unusable:
1. Never compute or reformat the amount. Copy it into "amount_text" exactly as
   it appears in the text, including separators and symbol (e.g. "$8.55",
   "COP7,525.00", "ARS23.280,00", "-COP124,414.00").
2. Set is_transaction=false for anything that must NOT be recorded at all:
   declined or rejected purchases, delivery/shipping updates, promotions, login
   alerts, price alerts, incoming transfers, balance updates. Explain in "reason".
3. A refund, reimbursement or chargeback is NOT covered by rule 2, even though
   it reduces spending instead of adding to it: set is_transaction=true and
   is_refund=true. It must be recorded — the app needs it to cancel out the
   original charge it reverses. Never set is_transaction=false for a refund.
4. Set understood=false if you cannot tell what the notification is. Do not guess.
5. "currency" must be an ISO code (USD, COP, ARS, EUR, USDT...) or null if the
   text only shows a bare "$" and you cannot tell.
6. "text_regex" must match this notification's text and expose the amount as a
   named group: (?<amount>...). Optionally (?<merchant>...) and (?<card>\\d{4}).
   It must be general enough for the next notification of the same format
   (do not hardcode this merchant or this amount) and specific enough not to
   match a different format. Use null if you cannot write one.

Respond with JSON only:
{"understood":bool,"is_transaction":bool,"is_refund":bool,"reason":string,
 "amount_text":string|null,"currency":string|null,"merchant":string|null,
 "account_name":string|null,"text_regex":string|null}`;
}

async function callOpenAi(prompt: string, apiKey: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        // Structuring one notification is a transcription job, not a reasoning
        // one: effort "low" tripled the latency and produced no better patterns.
        reasoning_effort: "none",
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error("[llm-fallback] OpenAI error:", response.status);
      return null;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    return JSON.parse(content);
  } catch (e) {
    console.error("[llm-fallback] OpenAI request failed:", e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Asks the model to structure an unrecognized notification, verifies every
 * claim it makes, and — if the extraction holds up — persists a self-verified
 * template so the next notification of this format needs no AI call.
 */
export async function llmFallbackParser(
  payload: PushPayload,
  userId: string,
  accounts: readonly AccountCandidate[],
): Promise<ParseResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[llm-fallback] OPENAI_API_KEY not set, skipping");
    return { kind: "unknown" };
  }

  const knownPatterns = await loadKnownPatterns(userId, payload.packageName);
  const raw = await callOpenAi(buildPrompt(payload, accounts, knownPatterns), apiKey);
  if (raw === null) return { kind: "unknown" };

  const parsed = llmExtractionSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[llm-fallback] response failed schema validation:", parsed.error.message);
    return { kind: "unknown" };
  }
  const extraction = parsed.data;

  if (!extraction.understood) {
    console.log(`[llm-fallback] model could not classify ${payload.packageName}: ${extraction.reason}`);
    return { kind: "unknown" };
  }

  if (!extraction.is_transaction) {
    await saveTemplate(payload, userId, extraction, { outcome: "ignore" });
    return { kind: "ignore", reason: extraction.reason || "classified as non-transactional by AI" };
  }

  const verified = verifyExtraction(payload, extraction, accounts);
  if (!verified) return { kind: "unknown" };

  const outcome: TemplateOutcome = extraction.is_refund ? "refund" : "expense";
  await saveTemplate(payload, userId, extraction, { outcome, expected: verified });

  return { kind: "transaction", tx: verified };
}

/**
 * Turns the model's claims into a transaction, rejecting the whole extraction if
 * any claim fails. The amount is re-derived here; the model's own arithmetic is
 * never used.
 */
function verifyExtraction(
  payload: PushPayload,
  extraction: LlmExtraction,
  accounts: readonly AccountCandidate[],
): ParsedTransaction | null {
  const { amount_text: amountText } = extraction;
  if (amountText === null || amountText.trim() === "") {
    console.error("[llm-fallback] transaction reported without an amount");
    return null;
  }

  // Anti-hallucination: the quote has to be in the notification we sent.
  const haystack = `${payload.title} ${payload.text}`;
  if (!haystack.includes(amountText.trim())) {
    console.error(`[llm-fallback] amount_text "${amountText}" does not appear in the notification`);
    return null;
  }

  const currency = extraction.currency?.toUpperCase() ?? null;
  if (currency !== null && !isKnownCurrency(currency)) {
    console.error(`[llm-fallback] unknown currency: ${currency}`);
    return null;
  }

  const amount = parseAmount(amountText, currency);
  if (amount === null || amount === 0) {
    console.error(`[llm-fallback] could not parse amount_text "${amountText}"`);
    return null;
  }

  // The model may only name an account that exists.
  const claimedName = extraction.account_name?.trim() ?? null;
  const accountName =
    claimedName !== null && accounts.some((a) => a.name === claimedName) ? claimedName : null;
  if (claimedName !== null && accountName === null) {
    console.error(`[llm-fallback] discarding invented account name: ${claimedName}`);
  }

  return {
    amount_native: extraction.is_refund ? -Math.abs(amount) : Math.abs(amount),
    native_currency: currency,
    merchant: extraction.merchant?.trim() || null,
    tx_date: resolveTxDate(payload.timestamp),
    description_raw: `${payload.title}: ${payload.text}`,
    // Falls back to the card digits in the text, which the resolver trusts most.
    account_name: accountName ?? "",
    card_last4: extractCardLast4(payload.text),
  };
}

async function loadKnownPatterns(userId: string, packageName: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("push_parser_templates")
    .select("text_pattern")
    .eq("user_id", userId)
    .eq("package_name", packageName);

  if (error) {
    console.error(`[llm-fallback] could not load known patterns for ${packageName}:`, error.message);
    return [];
  }
  return (data ?? []).map((row: { text_pattern: string }) => row.text_pattern);
}

/**
 * Persists an AI-authored pattern, but only after replaying it through
 * `applyTemplate` over the notification it was learned from and confirming it
 * reproduces the same extraction. A template that cannot parse its own source
 * text would silently cost an AI call on every future notification.
 */
async function saveTemplate(
  payload: PushPayload,
  userId: string,
  extraction: LlmExtraction,
  target: { outcome: TemplateOutcome; expected?: ParsedTransaction },
): Promise<void> {
  const pattern = extraction.text_regex;
  if (pattern === null || pattern.trim() === "") return;

  if (target.outcome !== "ignore" && !RE_HAS_AMOUNT_GROUP.test(pattern)) {
    console.log(`[llm-fallback] rejecting pattern without a named amount group: ${pattern}`);
    return;
  }
  if (compilePattern(pattern) === null) {
    console.log(`[llm-fallback] rejecting unsafe or invalid pattern: ${pattern}`);
    return;
  }

  const currency = extraction.currency?.toUpperCase() ?? null;
  if (target.outcome !== "ignore" && (currency === null || !isKnownCurrency(currency))) {
    // Without a currency the template cannot parse amounts safely; this
    // notification is still returned, it just does not become a template.
    console.log("[llm-fallback] not storing template: currency undetermined");
    return;
  }

  const candidate: ParserTemplate = {
    id: "candidate",
    text_pattern: pattern,
    title_pattern: null,
    amount_group: null,
    merchant_group: null,
    currency: currency ?? "",
    account_name: target.expected?.account_name ?? extraction.account_name ?? "",
    outcome: target.outcome,
    hit_count: 0,
  };

  const replay = applyTemplate(candidate, payload);
  if (target.outcome === "ignore") {
    if (replay.kind !== "ignore") {
      console.log(`[llm-fallback] ignore template does not match its own text: ${pattern}`);
      return;
    }
  } else {
    const expected = target.expected;
    if (replay.kind !== "transaction" || !expected) {
      console.log(`[llm-fallback] template does not reproduce its own extraction: ${pattern}`);
      return;
    }
    if (replay.tx.amount_native !== expected.amount_native) {
      console.log(
        `[llm-fallback] template amount mismatch (${replay.tx.amount_native} vs ${expected.amount_native}): ${pattern}`,
      );
      return;
    }
  }

  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("push_parser_templates")
    .select("id")
    .eq("user_id", userId)
    .eq("package_name", payload.packageName)
    .eq("text_pattern", pattern)
    .limit(1);
  if (existingError) {
    console.error("[llm-fallback] template lookup failed:", existingError.message);
    return;
  }
  if (existing && existing.length > 0) return;

  const { error: insertError } = await supabase.from("push_parser_templates").insert({
    user_id: userId,
    package_name: payload.packageName,
    text_pattern: pattern,
    title_pattern: null,
    amount_group: null,
    merchant_group: null,
    currency: candidate.currency,
    account_name: candidate.account_name,
    outcome: target.outcome,
    source_title: payload.title,
    source_text: payload.text,
  });
  if (insertError) {
    // Not fatal: this notification was still parsed, but every future one of the
    // same format will pay for another AI call.
    console.error(`[llm-fallback] template insert failed for ${payload.packageName}:`, insertError.message);
    return;
  }

  console.log(`[llm-fallback] learned ${target.outcome} template for ${payload.packageName}: ${pattern}`);
}
