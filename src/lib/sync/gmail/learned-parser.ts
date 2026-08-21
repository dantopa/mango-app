/**
 * Learned Gmail parsing: the AI structures an unknown email format once, and
 * deterministic code runs the resulting pattern forever after.
 *
 * This is the Gmail counterpart of `push-ingest/parsers/llm-fallback.ts`, and it
 * obeys the same rules — the ones that make an AI in the ingest path safe:
 *
 *  1. It only ever sees emails the hand-written parser did not recognize. A
 *     recognized non-transaction never reaches it, and neither does an ingreso:
 *     the orchestrator screens those out deterministically first.
 *  2. It never supplies a number. It quotes the amount as it literally appears
 *     in the email; we check the quote is really there and parse it ourselves.
 *  3. It never picks an account. The Gmail source already fixes that, so there
 *     is nothing for it to invent.
 *  4. A pattern is stored only if replaying it through `applyGmailTemplate` —
 *     the same function production uses — over the email it was learned from
 *     reproduces the same amount. A pattern that cannot parse its own source
 *     text would cost an AI call on every future email of that format.
 *
 * Templates live in `push_parser_templates` under `package_name = "gmail.<id>"`,
 * the namespace `push_ingest_log` already uses for Gmail rows.
 */
import { z } from "zod";

import type { CandidateTransaction } from "../types";
import type { GmailSourceDef, GmailSourceId, ParsedEmail } from "./types";
import { extractCardLast4 } from "../../push-ingest/account-resolver";
import { isKnownCurrency, parseAmount } from "../../push-ingest/money";
import { getSupabaseAdmin } from "../../push-ingest/supabase-admin";
import { internalDateToLocal, normalizeDate } from "./money";

const OPENAI_MODEL = "gpt-5.6-luna";
const OPENAI_TIMEOUT_MS = 15_000;

/** Cap on an AI-authored pattern; anything longer is not an email format. */
const MAX_PATTERN_LENGTH = 400;

/**
 * How much of the body the model gets. Bank emails put the transaction in the
 * first paragraph and then pile on legal boilerplate; sending the whole thing
 * costs tokens and buries the signal. Verification still runs on the full body.
 */
const MAX_PROMPT_BODY_CHARS = 2_500;

/** Nested quantifiers such as `(.+)+` can blow up on adversarial input. */
const RE_NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*]/;

/** A pattern that extracts a transaction must expose the amount as a named group. */
const RE_HAS_AMOUNT_GROUP = /\(\?<amount>/;

/** Day-first date as Colombian banks write it, the only form `normalizeDate` accepts. */
const RE_DAY_FIRST_DATE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

const MAX_DESCRIPTION_CHARS = 200;

/** Shares the `gmail.<id>` namespace with `push_ingest_log`. */
export function templateKey(sourceId: GmailSourceId): string {
  return `gmail.${sourceId}`;
}

export type TemplateOutcome = "expense" | "refund" | "ignore";

export type GmailTemplate = {
  id: string;
  /** Matched against the email subject; null matches any subject. */
  title_pattern: string | null;
  text_pattern: string;
  currency: string;
  outcome: TemplateOutcome;
  hit_count: number;
};

const TEMPLATE_COLUMNS = "id, title_pattern, text_pattern, currency, outcome, hit_count";

export type TemplateExtraction =
  | { kind: "transaction"; tx: CandidateTransaction }
  | { kind: "ignore" }
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

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Runs a template over an email.
 *
 * The single implementation of template execution: production reads and the
 * save-time self-test both go through it, so a stored template cannot behave
 * differently from the one that was verified.
 */
export function applyGmailTemplate(
  template: GmailTemplate,
  email: ParsedEmail,
  sourceDef: GmailSourceDef,
): TemplateExtraction {
  if (template.title_pattern !== null) {
    const subjectRe = compilePattern(template.title_pattern);
    if (!subjectRe || !subjectRe.test(email.subject)) return { kind: "no_match" };
  }

  const textRe = compilePattern(template.text_pattern);
  if (!textRe) return { kind: "no_match" };

  const match = email.bodyText.match(textRe);
  if (!match) return { kind: "no_match" };

  if (template.outcome === "ignore") return { kind: "ignore" };

  const amountRaw = match.groups?.amount;
  if (amountRaw === undefined) return { kind: "no_match" };

  const amount = parseAmount(amountRaw, template.currency);
  if (amount === null || amount === 0) return { kind: "no_match" };

  const dateRaw = match.groups?.date?.trim();
  const txDate =
    dateRaw !== undefined && RE_DAY_FIRST_DATE.test(dateRaw)
      ? normalizeDate(dateRaw)
      : internalDateToLocal(email.internalDate);

  const merchant = match.groups?.merchant?.trim();

  return {
    kind: "transaction",
    tx: {
      // A refund reduces spending, so it is always stored negative.
      amount_native: template.outcome === "refund" ? -Math.abs(amount) : Math.abs(amount),
      native_currency: template.currency,
      merchant: merchant || null,
      tx_date: txDate,
      // The matched sentence, not a blind slice of the email: it is the part the
      // pattern actually recognized.
      description_raw: collapse(match[0]).slice(0, MAX_DESCRIPTION_CHARS),
      account_name: sourceDef.accountName,
      source: sourceDef.syncSource,
      card_last4: match.groups?.card ?? extractCardLast4(email.bodyText),
    },
  };
}

/** What a learned-template pass concluded about an email. */
export type LearnedResult =
  | { kind: "transaction"; candidates: CandidateTransaction[] }
  | { kind: "ignore" }
  | { kind: "unknown" };

/**
 * Tries every learned template for this source, most-used first.
 * Returns `unknown` when none match — the only case worth an AI call.
 */
export async function tryLearnedTemplates(
  email: ParsedEmail,
  sourceDef: GmailSourceDef,
  userId: string,
): Promise<LearnedResult> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("push_parser_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("user_id", userId)
    .eq("package_name", templateKey(sourceDef.id))
    .order("hit_count", { ascending: false });

  if (error) {
    console.error(`[gmail-learned] template query failed for ${sourceDef.id}:`, error.message);
    return { kind: "unknown" };
  }
  if (!data || data.length === 0) return { kind: "unknown" };

  for (const template of data as GmailTemplate[]) {
    const extraction = applyGmailTemplate(template, email, sourceDef);
    if (extraction.kind === "no_match") continue;

    const { error: hitError } = await supabase
      .from("push_parser_templates")
      .update({ hit_count: template.hit_count + 1, last_hit_at: new Date().toISOString() })
      .eq("id", template.id);
    if (hitError) {
      console.error(`[gmail-learned] hit_count update failed for ${template.id}:`, hitError.message);
    }

    return extraction.kind === "ignore"
      ? { kind: "ignore" }
      : { kind: "transaction", candidates: [extraction.tx] };
  }

  return { kind: "unknown" };
}

// --- AI pass -----------------------------------------------------------------

/**
 * What the model is allowed to tell us. Every field is a claim to be verified,
 * not a value to be stored — except `merchant`, which is free text either way.
 */
const extractionSchema = z.object({
  understood: z.boolean(),
  is_transaction: z.boolean(),
  is_refund: z.boolean(),
  reason: z.string().max(200),
  /** The amount exactly as it appears in the email, e.g. "$47.000,00". */
  amount_text: z.string().max(40).nullable(),
  currency: z.string().max(5).nullable(),
  merchant: z.string().max(200).nullable(),
  /** The transaction date exactly as it appears, e.g. "12/08/2026". */
  date_text: z.string().max(40).nullable(),
  /** Regex with a named `amount` group, optionally `merchant`, `date` and `card`. */
  text_regex: z.string().max(MAX_PATTERN_LENGTH).nullable(),
});

/** Exported so the verification gates can be tested without calling OpenAI. */
export type Extraction = z.infer<typeof extractionSchema>;

function buildPrompt(
  email: ParsedEmail,
  sourceDef: GmailSourceDef,
  knownPatterns: string[],
): string {
  const patternList = knownPatterns.length
    ? knownPatterns.map((p) => `- ${p}`).join("\n")
    : "- (none yet)";

  return `You are converting a bank email into structured data for a personal finance app.

Source: ${sourceDef.id} — every transaction from it belongs to the account "${sourceDef.accountName}".

Subject: ${email.subject}

Body:
${email.bodyText.slice(0, MAX_PROMPT_BODY_CHARS)}

Patterns already learned for this source (write a NEW pattern only if none of these fit):
${patternList}

Rules — a violation makes the whole answer unusable:
1. Never compute or reformat the amount. Copy it into "amount_text" exactly as it
   appears in the body, including separators and symbol (e.g. "$47.000,00",
   "COP 7,525.00", "USD 16.91").
2. Set is_transaction=false for anything that must NOT be recorded at all: money
   received (transfers or payments IN), declined or rejected purchases, monthly
   statements and summaries, balance updates, promotions, security alerts.
   Explain which one in "reason".
3. A refund, reimbursement or chargeback is NOT covered by rule 2, even though
   it reduces spending instead of adding to it: set is_transaction=true and
   is_refund=true. It must be recorded — the app needs it to cancel out the
   original charge it reverses. Never set is_transaction=false for a refund.
4. Set understood=false if you cannot tell what the email is. Do not guess.
5. "currency" must be an ISO code (COP, USD, ARS, EUR...) or null if the body only
   shows a bare "$" and you cannot tell.
6. "date_text" is the transaction date copied exactly as written (day first, e.g.
   "12/08/2026"), or null if the body does not state one.
7. "text_regex" must match this body and expose the amount as a named group:
   (?<amount>...). Optionally (?<merchant>...), (?<date>...) and (?<card>\\d{4}).
   It must be general enough for the next email of the same format — do not
   hardcode this merchant, this amount or this date — and specific enough not to
   match a different format. Use null if you cannot write one.

Respond with JSON only:
{"understood":bool,"is_transaction":bool,"is_refund":bool,"reason":string,
 "amount_text":string|null,"currency":string|null,"merchant":string|null,
 "date_text":string|null,"text_regex":string|null}`;
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
        // Structuring one email is transcription, not reasoning.
        reasoning_effort: "none",
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error("[gmail-learned] OpenAI error:", response.status);
      return null;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    return JSON.parse(content);
  } catch (e) {
    console.error("[gmail-learned] OpenAI request failed:", e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Turns the model's claims into a candidate, rejecting the whole extraction if
 * any claim fails. The amount is re-derived here; the model's arithmetic is
 * never used.
 *
 * Exported for tests: this is where the anti-hallucination checks live.
 */
export function verifyExtraction(
  email: ParsedEmail,
  extraction: Extraction,
  sourceDef: GmailSourceDef,
): CandidateTransaction | null {
  const amountText = extraction.amount_text?.trim();
  if (!amountText) {
    console.error("[gmail-learned] transaction reported without an amount");
    return null;
  }

  // Anti-hallucination: the quote has to be in the email we sent.
  const haystack = `${email.subject} ${email.bodyText}`;
  if (!haystack.includes(amountText)) {
    console.error(`[gmail-learned] amount_text "${amountText}" does not appear in the email`);
    return null;
  }

  const currency = extraction.currency?.toUpperCase() ?? null;
  if (currency === null || !isKnownCurrency(currency)) {
    console.error(`[gmail-learned] unusable currency: ${currency}`);
    return null;
  }

  const amount = parseAmount(amountText, currency);
  if (amount === null || amount === 0) {
    console.error(`[gmail-learned] could not parse amount_text "${amountText}"`);
    return null;
  }

  // Same rule for the date: quoted or not used at all.
  const dateText = extraction.date_text?.trim();
  const quotedDate =
    dateText && haystack.includes(dateText) && RE_DAY_FIRST_DATE.test(dateText) ? dateText : null;
  if (dateText && quotedDate === null) {
    console.error(`[gmail-learned] discarding unusable date_text "${dateText}"`);
  }

  return {
    amount_native: extraction.is_refund ? -Math.abs(amount) : Math.abs(amount),
    native_currency: currency,
    merchant: extraction.merchant?.trim() || null,
    tx_date: quotedDate ? normalizeDate(quotedDate) : internalDateToLocal(email.internalDate),
    description_raw: collapse(email.bodyText).slice(0, MAX_DESCRIPTION_CHARS),
    account_name: sourceDef.accountName,
    source: sourceDef.syncSource,
    card_last4: extractCardLast4(email.bodyText),
  };
}

/**
 * Asks the model to structure an unrecognized email, verifies every claim it
 * makes, and — if the extraction holds up — persists a self-verified pattern so
 * the next email of this format needs no AI call.
 */
export async function learnFromEmail(
  email: ParsedEmail,
  sourceDef: GmailSourceDef,
  userId: string,
): Promise<LearnedResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[gmail-learned] OPENAI_API_KEY not set, skipping");
    return { kind: "unknown" };
  }

  const knownPatterns = await loadKnownPatterns(userId, sourceDef.id);
  const raw = await callOpenAi(buildPrompt(email, sourceDef, knownPatterns), apiKey);
  if (raw === null) return { kind: "unknown" };

  const parsed = extractionSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[gmail-learned] response failed schema validation:", parsed.error.message);
    return { kind: "unknown" };
  }
  const extraction = parsed.data;

  if (!extraction.understood) {
    console.log(`[gmail-learned] model could not classify ${sourceDef.id}: ${extraction.reason}`);
    return { kind: "unknown" };
  }

  if (!extraction.is_transaction) {
    await saveTemplate(email, sourceDef, userId, extraction, { outcome: "ignore" });
    return { kind: "ignore" };
  }

  const verified = verifyExtraction(email, extraction, sourceDef);
  if (verified === null) return { kind: "unknown" };

  const outcome: TemplateOutcome = extraction.is_refund ? "refund" : "expense";
  const stored = await saveTemplate(email, sourceDef, userId, extraction, {
    outcome,
    expected: verified,
  });

  // When the pattern replays cleanly, the template's own output is what gets
  // registered, so the first email of a format lands exactly like every one
  // after it. Otherwise fall back to the directly verified extraction.
  return { kind: "transaction", candidates: [stored ?? verified] };
}

async function loadKnownPatterns(userId: string, sourceId: GmailSourceId): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("push_parser_templates")
    .select("text_pattern")
    .eq("user_id", userId)
    .eq("package_name", templateKey(sourceId));

  if (error) {
    console.error(`[gmail-learned] could not load known patterns for ${sourceId}:`, error.message);
    return [];
  }
  return (data ?? []).map((row: { text_pattern: string }) => row.text_pattern);
}

/**
 * Decides whether an AI-authored pattern is fit to store, by replaying it over
 * the email it was learned from.
 *
 * Pure and exported so the gate can be tested without a database: returns the
 * template row to insert plus what it produces, or null to store nothing.
 */
export function vetTemplate(
  email: ParsedEmail,
  sourceDef: GmailSourceDef,
  extraction: Extraction,
  target: { outcome: TemplateOutcome; expected?: CandidateTransaction },
): { template: GmailTemplate; produced: CandidateTransaction | null } | null {
  const pattern = extraction.text_regex?.trim();
  if (!pattern) return null;

  if (target.outcome !== "ignore" && !RE_HAS_AMOUNT_GROUP.test(pattern)) {
    console.log(`[gmail-learned] rejecting pattern without a named amount group: ${pattern}`);
    return null;
  }
  if (compilePattern(pattern) === null) {
    console.log(`[gmail-learned] rejecting unsafe or invalid pattern: ${pattern}`);
    return null;
  }

  const currency = extraction.currency?.toUpperCase() ?? null;
  if (target.outcome !== "ignore" && (currency === null || !isKnownCurrency(currency))) {
    // Without a currency the template cannot parse amounts safely. The email is
    // still returned; it just does not become a template.
    console.log("[gmail-learned] not storing template: currency undetermined");
    return null;
  }

  const template: GmailTemplate = {
    id: "candidate",
    title_pattern: null,
    text_pattern: pattern,
    currency: currency ?? "",
    outcome: target.outcome,
    hit_count: 0,
  };

  const replay = applyGmailTemplate(template, email, sourceDef);

  if (target.outcome === "ignore") {
    if (replay.kind !== "ignore") {
      console.log(`[gmail-learned] ignore pattern does not match its own email: ${pattern}`);
      return null;
    }
    return { template, produced: null };
  }

  const expected = target.expected;
  if (replay.kind !== "transaction" || !expected) {
    console.log(`[gmail-learned] pattern does not reproduce its own extraction: ${pattern}`);
    return null;
  }
  if (replay.tx.amount_native !== expected.amount_native) {
    console.log(
      `[gmail-learned] pattern amount mismatch (${replay.tx.amount_native} vs ${expected.amount_native}): ${pattern}`,
    );
    return null;
  }
  // A pattern that loses the date would silently file every future email of this
  // format under its arrival day instead of the day of the purchase.
  if (replay.tx.tx_date !== expected.tx_date) {
    console.log(
      `[gmail-learned] pattern date mismatch (${replay.tx.tx_date} vs ${expected.tx_date}): ${pattern}`,
    );
    return null;
  }

  return { template, produced: replay.tx };
}

/**
 * Persists a vetted pattern. Returns what the stored template produces, or null
 * if nothing was stored.
 */
async function saveTemplate(
  email: ParsedEmail,
  sourceDef: GmailSourceDef,
  userId: string,
  extraction: Extraction,
  target: { outcome: TemplateOutcome; expected?: CandidateTransaction },
): Promise<CandidateTransaction | null> {
  const vetted = vetTemplate(email, sourceDef, extraction, target);
  if (vetted === null) return null;

  const supabase = getSupabaseAdmin();
  const packageName = templateKey(sourceDef.id);

  const { data: existing, error: lookupError } = await supabase
    .from("push_parser_templates")
    .select("id")
    .eq("user_id", userId)
    .eq("package_name", packageName)
    .eq("text_pattern", vetted.template.text_pattern)
    .limit(1);
  if (lookupError) {
    console.error("[gmail-learned] template lookup failed:", lookupError.message);
    return vetted.produced;
  }
  if (existing && existing.length > 0) return vetted.produced;

  const { error: insertError } = await supabase.from("push_parser_templates").insert({
    user_id: userId,
    package_name: packageName,
    text_pattern: vetted.template.text_pattern,
    title_pattern: null,
    amount_group: null,
    merchant_group: null,
    currency: vetted.template.currency,
    account_name: sourceDef.accountName,
    outcome: target.outcome,
    source_title: email.subject,
    source_text: email.bodyText.slice(0, MAX_PROMPT_BODY_CHARS),
  });
  if (insertError) {
    // Not fatal: this email was still parsed, but every future one of the same
    // format will pay for another AI call.
    console.error(`[gmail-learned] template insert failed for ${sourceDef.id}:`, insertError.message);
    return vetted.produced;
  }

  console.log(
    `[gmail-learned] learned ${target.outcome} pattern for ${sourceDef.id}: ${vetted.template.text_pattern}`,
  );
  return vetted.produced;
}
