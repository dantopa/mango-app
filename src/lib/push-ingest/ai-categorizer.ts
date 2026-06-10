/**
 * AI-powered categorizer fallback.
 *
 * When the deterministic categorizer (merchant_category_rules) has no match,
 * calls GPT-4o-mini to suggest a category. If confident, auto-creates a rule
 * so the same merchant is categorized deterministically next time.
 *
 * Cost: ~$0.001 per transaction (input + output tokens).
 */
import { getSupabaseAdmin } from "./supabase-admin";

export type AiCategorizationResult =
  | { matched: true; category_id: string; category_name: string; auto_rule_created: boolean }
  | { matched: false; reason: string };

type CategoryOption = {
  id: string;
  name: string;
};

/**
 * Use AI to categorize a merchant into one of the user's categories.
 * On success, inserts a merchant_category_rule for future deterministic matching.
 */
export async function categorizeWithAi(
  merchant: string,
  descriptionRaw: string,
  userId: string,
): Promise<AiCategorizationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { matched: false, reason: "OPENAI_API_KEY not configured" };
  }

  const supabase = getSupabaseAdmin();

  // Fetch user's categories
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: categories, error: catError } = await (supabase as any)
    .from("categories")
    .select("id, name")
    .eq("user_id", userId);

  if (catError || !categories || categories.length === 0) {
    return { matched: false, reason: "No categories found for user" };
  }

  const categoryOptions = categories as CategoryOption[];
  const categoryList = categoryOptions.map((c) => c.name).join(", ");

  // Build the prompt
  const systemPrompt = `Sos un categorizador de gastos personales. Dado un merchant y descripción de una transacción bancaria, asigná UNA categoría de la lista proporcionada.

Categorías disponibles: ${categoryList}

Reglas:
- Respondé SOLO con el nombre exacto de la categoría (tal cual está en la lista).
- Si no podés categorizar con confianza, respondé "UNKNOWN".
- "Suscripciones" incluye servicios digitales recurrentes (Spotify, Netflix, Anthropic, Proton, Tidal, Google services).
- "Restaurantes/Bares" incluye locales de comida, cafés, bares, panaderías.
- "Cafés" es específico para cafeterías (no restaurantes).
- "Delivery comida" incluye Rappi, PedidosYa, iFood, etc.
- "Transporte (Uber/Didi)" incluye taxis, Uber, Didi, InDrive.
- "Mercado/Super" incluye supermercados, minimercados, tiendas de barrio.
- "Vivienda/Arriendo" incluye arriendo, servicios públicos (agua, luz, gas), PSE de empresas públicas.
- "Compras/Hogar" incluye ropa, electrónica, muebles, ferretería, llaves, reparaciones.
- "Servicios (internet/telefonía)" incluye planes de celular, internet hogar.
- "Gym/Salud física" incluye gym, yoga, pilates.
- "Salud/Farmacia" incluye farmacias, médicos, EPS.
- "Varios" es último recurso cuando realmente no encaja en nada.`;

  const userMessage = `Merchant: "${merchant}"
Descripción: "${descriptionRaw}"`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0,
        max_tokens: 50,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return { matched: false, reason: `OpenAI API error: ${response.status}` };
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim();

    if (!answer || answer === "UNKNOWN") {
      return { matched: false, reason: "AI could not categorize" };
    }

    // Find matching category (case-insensitive)
    const matchedCategory = categoryOptions.find(
      (c) => c.name.toLowerCase() === answer.toLowerCase()
    );

    if (!matchedCategory) {
      return { matched: false, reason: `AI suggested "${answer}" which doesn't match any category` };
    }

    // Auto-create rule for future deterministic matching
    // Use a simplified pattern from the merchant name (first meaningful word or phrase)
    const pattern = extractPattern(merchant);
    let autoRuleCreated = false;

    if (pattern) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: ruleError } = await (supabase as any)
        .from("merchant_category_rules")
        .insert({
          user_id: userId,
          pattern,
          match_type: "ilike",
          category_id: matchedCategory.id,
          priority: -10, // AI-generated: below manual rules (default 0) so human corrections always win
        });

      if (!ruleError) {
        autoRuleCreated = true;
        console.log(`[ai-categorizer] Created rule: "${pattern}" → ${matchedCategory.name}`);
      }
    }

    return {
      matched: true,
      category_id: matchedCategory.id,
      category_name: matchedCategory.name,
      auto_rule_created: autoRuleCreated,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { matched: false, reason: `AI categorization failed: ${msg}` };
  }
}

/**
 * Extract a useful pattern from a Bancolombia-style merchant string.
 * Examples:
 *   "COMPRA EN PERGAMINO VIVA ENVIG" → "PERGAMINO"
 *   "COMPRA INTL Google Bumble Dati" → "Google Bumble"
 *   "PAGO QR ARES BARBERIA" → "ARES BARBERIA"
 *   "PAGO PSE EMPRESAS PUBLICAS D" → "EMPRESAS PUBLICAS"
 *   "Rappi" → "Rappi"
 *   "Anthropic" → "Anthropic"
 */
function extractPattern(merchant: string): string | null {
  if (!merchant || merchant.length < 3) return null;

  // Strip common Bancolombia prefixes
  const prefixes = [
    /^COMPRA EN\s+/i,
    /^COMPRA INTL\s+/i,
    /^COMPRA\s+/i,
    /^PAGO QR\s+/i,
    /^PAGO PSE\s+/i,
    /^PAGO\s+/i,
  ];

  let cleaned = merchant;
  for (const prefix of prefixes) {
    cleaned = cleaned.replace(prefix, "");
  }

  // Remove trailing location codes (single uppercase words ≤5 chars at end)
  cleaned = cleaned.replace(/\s+[A-Z]{1,5}$/, "").trim();

  // If cleaned result is too short, use original
  if (cleaned.length < 3) return merchant.trim();

  // Take first 2-3 meaningful words (enough to be distinctive)
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1);
  const pattern = words.slice(0, 3).join(" ");

  return pattern || null;
}
