import { getSupabaseAdmin } from "./supabase-admin";

export type ClassificationResult =
  | { type: "expense" }
  | { type: "transfer"; is_payment: true }
  | { type: "unknown"; needs_review: true };

type ClassificationRule = {
  id: string;
  pattern: string;
  match_type: string;
  list_type: string;
};

/**
 * Case-insensitive substring match (equivalent to SQL ILIKE '%pattern%').
 */
function ilikeMatch(text: string, pattern: string): boolean {
  return text.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Check if a text matches a rule pattern based on match_type.
 */
function matchesPattern(text: string, rule: ClassificationRule): boolean {
  if (rule.match_type === "regex") {
    try {
      const re = new RegExp(rule.pattern, "i");
      return re.test(text);
    } catch {
      return false;
    }
  }
  // Default: ilike
  return ilikeMatch(text, rule.pattern);
}

/**
 * Classify a transaction as expense, transfer, or unknown
 * using transfer_classification_rules for the user.
 *
 * - Allowlist match → transfer (is_payment: true)
 * - Denylist match → expense
 * - No match → unknown (needs_review: true)
 */
export async function classifyTransaction(
  parsed: { merchant: string | null; description_raw: string },
  userId: string,
): Promise<ClassificationResult> {
  const supabase = getSupabaseAdmin();
  const { data: rules, error } = await supabase
    .from("transfer_classification_rules")
    .select("id, pattern, match_type, list_type")
    .eq("user_id", userId);

  if (error || !rules) {
    console.error("[classifier] query error:", error?.message);
    return { type: "unknown", needs_review: true };
  }

  const typedRules: ClassificationRule[] = rules;

  // Check text to match against: combine merchant + description
  const textsToCheck: string[] = [];
  if (parsed.merchant) textsToCheck.push(parsed.merchant);
  if (parsed.description_raw) textsToCheck.push(parsed.description_raw);

  for (const rule of typedRules) {
    const matches = textsToCheck.some((text) => matchesPattern(text, rule));
    if (matches) {
      if (rule.list_type === "allowlist") {
        return { type: "transfer", is_payment: true };
      }
      if (rule.list_type === "denylist") {
        return { type: "expense" };
      }
    }
  }

  return { type: "unknown", needs_review: true };
}
