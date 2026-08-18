import type { ParsedTransaction, PushPayload } from "../types";
import { resolveTxDate } from "../dates";
import { PACKAGE_WHITELIST } from "../package-whitelist";
import { getSupabaseAdmin } from "../supabase-admin";

const OWNER_USER_ID = "e99371b1-6163-4216-b624-c79d8ee01520";

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

interface TemplateRow {
  id: string;
  text_pattern: string;
  title_pattern: string | null;
  amount_group: number;
  merchant_group: number | null;
  currency: string;
  account_name: string;
  is_expense: boolean;
  /** Not part of the select above, so it is absent at runtime. */
  hit_count?: number;
}

/**
 * Try to parse using a saved template from the DB.
 * Returns parsed transaction or null if no template matches.
 */
export async function tryTemplateParser(payload: PushPayload): Promise<ParsedTransaction | null> {
  const supabase = getSupabaseAdmin();

  const { data: templates } = await supabase
    .from("push_parser_templates")
    .select("id, text_pattern, title_pattern, amount_group, merchant_group, currency, account_name, is_expense")
    .eq("user_id", OWNER_USER_ID)
    .eq("package_name", payload.packageName);

  if (!templates || templates.length === 0) return null;

  for (const tpl of templates as TemplateRow[]) {
    // Check title pattern if specified
    if (tpl.title_pattern) {
      try {
        const titleRe = new RegExp(tpl.title_pattern, "i");
        if (!titleRe.test(payload.title)) continue;
      } catch { continue; }
    }

    // Check text pattern
    try {
      const textRe = new RegExp(tpl.text_pattern, "i");
      const match = payload.text.match(textRe);
      if (!match) continue;

      // Not an expense — return null to skip
      if (!tpl.is_expense) return null;

      // Extract amount
      const amountRaw = match[tpl.amount_group];
      if (!amountRaw) continue;
      const amount = parseAmount(amountRaw);
      if (!amount || amount <= 0) continue;

      // Extract merchant if available
      const merchant = tpl.merchant_group ? (match[tpl.merchant_group] ?? null) : null;

      // Update hit count
      await supabase
        .from("push_parser_templates")
        .update({ hit_count: (tpl.hit_count ?? 0) + 1, last_hit_at: new Date().toISOString() })
        .eq("id", tpl.id);

      return {
        amount_native: amount,
        native_currency: tpl.currency,
        merchant: merchant?.trim() ?? null,
        tx_date: resolveTxDate(payload.timestamp),
        description_raw: `${payload.title}: ${payload.text}`,
        account_name: tpl.account_name,
      };
    } catch { continue; }
  }

  return null;
}

interface LlmExtraction {
  is_expense: boolean;
  amount: number | null;
  currency: string;
  merchant: string | null;
  account_name: string;
  text_regex: string | null; // Pattern the LLM suggests for future matches
  amount_group: number;
  merchant_group: number | null;
}

/**
 * LLM fallback: ask GPT to extract transaction data from the notification.
 * Also asks it to suggest a regex template for future use.
 */
export async function llmFallbackParser(payload: PushPayload): Promise<ParsedTransaction | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[llm-fallback] OPENAI_API_KEY not set, skipping");
    return null;
  }

  const prompt = `Analyze this push notification from a mobile banking/payment app and extract financial transaction data if present.

Package: ${payload.packageName}
Title: ${payload.title}
Text: ${payload.text}

Respond in JSON only:
{
  "is_expense": boolean, // true if this is a purchase/payment notification, false if it's delivery, promo, login, etc
  "amount": number|null, // transaction amount (positive number), null if not a transaction
  "currency": "COP"|"ARS"|"USD", // currency code
  "merchant": string|null, // merchant/store name if identifiable
  "account_name": string, // which account this belongs to (e.g. "Rappi", "Nequi", "BBVA Visa", "Bancolombia Ahorros")
  "text_regex": string|null, // a regex pattern that would match this notification format and extract amount (group 1) and merchant (group 2). Use named groups if possible. null if you can't generalize.
  "amount_group": number, // which capture group in the regex is the amount (1-indexed)
  "merchant_group": number|null // which capture group is the merchant, null if not extractable by regex
}`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      console.error("[llm-fallback] OpenAI error:", response.status);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const extraction: LlmExtraction = JSON.parse(content);

    // Not an expense — skip and save template so we don't call LLM again for this format
    if (!extraction.is_expense || !extraction.amount) {
      if (extraction.text_regex) {
        await saveTemplate(payload.packageName, extraction, false);
      }
      return null;
    }

    // Save template for future use
    if (extraction.text_regex) {
      await saveTemplate(payload.packageName, extraction, true);
    }

    return {
      amount_native: extraction.amount,
      native_currency: extraction.currency,
      merchant: extraction.merchant,
      tx_date: resolveTxDate(payload.timestamp),
      description_raw: `${payload.title}: ${payload.text}`,
      account_name: extraction.account_name,
    };
  } catch (e) {
    console.error("[llm-fallback] error:", e);
    return null;
  }
}

/** Save the LLM-suggested regex as a template in the DB */
async function saveTemplate(packageName: string, extraction: LlmExtraction, isExpense: boolean): Promise<void> {
  if (!extraction.text_regex) return;

  // Validate the regex is actually valid
  try {
    new RegExp(extraction.text_regex, "i");
  } catch {
    console.log("[llm-fallback] invalid regex suggested:", extraction.text_regex);
    return;
  }

  const supabase = getSupabaseAdmin();

  // Check if we already have a template with this exact pattern
  const { data: existing } = await supabase
    .from("push_parser_templates")
    .select("id")
    .eq("user_id", OWNER_USER_ID)
    .eq("package_name", packageName)
    .eq("text_pattern", extraction.text_regex)
    .limit(1);

  if (existing && existing.length > 0) return; // Already saved

  await supabase.from("push_parser_templates").insert({
    user_id: OWNER_USER_ID,
    package_name: packageName,
    text_pattern: extraction.text_regex,
    title_pattern: null,
    amount_group: extraction.amount_group,
    merchant_group: extraction.merchant_group,
    currency: extraction.currency,
    account_name: extraction.account_name,
    is_expense: isExpense,
  });

  console.log(`[llm-fallback] saved template for ${packageName}: ${extraction.text_regex}`);
}

// --- Helpers ---

function parseAmount(raw: string): number {
  // Handle various formats: "33.300" (CO dots=thousands), "17,50" (comma decimal), "827583"
  const cleaned = raw.replace(/\s/g, "");
  // If has dots but no comma → dots are thousands (Colombian)
  if (cleaned.includes(".") && !cleaned.includes(",")) {
    return parseFloat(cleaned.replace(/\./g, ""));
  }
  // If has comma → comma is decimal separator
  if (cleaned.includes(",")) {
    return parseFloat(cleaned.replace(/\./g, "").replace(",", "."));
  }
  return parseFloat(cleaned);
}
