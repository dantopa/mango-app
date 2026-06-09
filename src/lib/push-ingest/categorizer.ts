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
 * Check if a merchant matches a rule pattern based on match_type.
 * - 'ilike': case-insensitive substring match (equivalent to SQL ILIKE '%pattern%')
 * - 'regex': full regex match
 */
function matchesRule(merchant: string, rule: MerchantRule): boolean {
  if (rule.match_type === "regex") {
    try {
      const re = new RegExp(rule.pattern, "i");
      return re.test(merchant);
    } catch {
      return false;
    }
  }

  // Default: ilike — case-insensitive substring match
  return merchant.toLowerCase().includes(rule.pattern.toLowerCase());
}

/**
 * Look up merchant in merchant_category_rules for a given user.
 * Returns the highest-priority matching rule, or { matched: false }.
 */
export async function categorize(
  merchant: string | null,
  userId: string,
): Promise<CategorizationResult> {
  if (merchant === null) {
    return { matched: false };
  }

  const supabase = getSupabaseAdmin();
  // Cast needed: merchant_category_rules not yet in generated database.types.ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rules, error } = await (supabase as any)
    .from("merchant_category_rules")
    .select("id, pattern, match_type, category_id, priority")
    .eq("user_id", userId)
    .order("priority", { ascending: false });

  if (error || !rules) {
    console.error("[categorizer] query error:", error?.message);
    return { matched: false };
  }

  for (const rule of rules as MerchantRule[]) {
    if (matchesRule(merchant, rule)) {
      return { matched: true, category_id: rule.category_id, rule_id: rule.id };
    }
  }

  return { matched: false };
}
