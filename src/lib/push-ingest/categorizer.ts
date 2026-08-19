import { getSupabaseAdmin } from "./supabase-admin";

export type CategorizationResult =
  | { matched: true; category_id: string; rule_id: string }
  | { matched: false };

type MerchantRule = {
  id: string;
  pattern: string;
  match_type: string;
  category_id: string;
  priority: number;
};

/**
 * Check if the text matches a rule pattern based on match_type.
 * - 'ilike': case-insensitive substring match (equivalent to SQL ILIKE '%pattern%')
 * - 'regex': full regex match
 */
function matchesRule(text: string, rule: MerchantRule): boolean {
  if (rule.match_type === "regex") {
    try {
      const re = new RegExp(rule.pattern, "i");
      return re.test(text);
    } catch {
      return false;
    }
  }

  // Default: ilike — case-insensitive substring match
  return text.toLowerCase().includes(rule.pattern.toLowerCase());
}

/**
 * Resolve which text a rule is tested against.
 *
 * A Bancolombia transfer or QR payment has no merchant at all — its counterparty
 * is an account number or a llave sitting inside the raw text. Falling back to
 * `description_raw` is what makes those reachable by a rule; before this, they
 * were a dead end that landed in "para revisión" forever.
 */
export function matchTarget(
  merchant: string | null,
  descriptionRaw?: string | null,
): string | null {
  return merchant ?? descriptionRaw ?? null;
}

/**
 * Look up a transaction in merchant_category_rules for a given user.
 * Returns the highest-priority matching rule, or { matched: false }.
 */
export async function categorize(
  merchant: string | null,
  userId: string,
  descriptionRaw?: string | null,
): Promise<CategorizationResult> {
  const target = matchTarget(merchant, descriptionRaw);
  if (target === null) {
    return { matched: false };
  }

  const supabase = getSupabaseAdmin();
  const { data: rules, error } = await supabase
    .from("merchant_category_rules")
    .select("id, pattern, match_type, category_id, priority")
    .eq("user_id", userId)
    .order("priority", { ascending: false });

  if (error || !rules) {
    console.error("[categorizer] query error:", error?.message);
    return { matched: false };
  }

  for (const rule of rules) {
    if (matchesRule(target, rule)) {
      return { matched: true, category_id: rule.category_id, rule_id: rule.id };
    }
  }

  return { matched: false };
}
