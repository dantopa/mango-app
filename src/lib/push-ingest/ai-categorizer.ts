/**
 * AI-powered categorizer fallback.
 *
 * When the deterministic categorizer (merchant_category_rules) has no match, the
 * model picks a category and — this is the point — hands back the fragment of
 * text that identifies the counterparty, which becomes a rule. From then on the
 * same counterparty is categorized deterministically, with no LLM in the path.
 *
 * Two hard signatures stand between the model and the database, because a bad
 * rule is worse than no rule (it silently miscategorizes everything it touches):
 *
 *  1. The pattern must be literally present in the text it came from
 *     (`isUsablePattern`) — the model quotes, it never invents.
 *  2. Replaying the pattern over already-categorized history must not contradict
 *     a single existing categorization (`conflictsWithHistory`). This is what
 *     kills a generic pattern like "Bancolombia le informa" before it can be
 *     stored.
 *
 * Cost: ~300 input + ~40 output tokens per uncategorized transaction, once — the
 * rule handles every repeat.
 */
import { getSupabaseAdmin } from "./supabase-admin";
import { extractPattern, isUsablePattern } from "./pattern";
import { matchTarget } from "./categorizer";

/**
 * Cheapest model of the current generation. Its parameter rules differ from the
 * older ones: `temperature` only accepts the default, and the token cap is
 * `max_completion_tokens` — `max_tokens` is a hard 400, which is what silently
 * disabled this whole path.
 */
const OPENAI_MODEL = "gpt-5.6-luna";

/** How much categorized history the pattern is replayed against. */
const HISTORY_SAMPLE = 300;

export type AiCategorizationResult =
  | { matched: true; category_id: string; category_name: string; auto_rule_created: boolean }
  | { matched: false; reason: string };

type CategoryOption = {
  id: string;
  name: string;
};

/**
 * Use AI to categorize a transaction into one of the user's categories.
 * On success, inserts a merchant_category_rule for future deterministic matching.
 *
 * `merchant` is nullable on purpose: transfers and QR payments arrive without
 * one, and they are exactly the rows that keep piling up in "para revisión".
 */
export async function categorizeWithAi(
  merchant: string | null,
  descriptionRaw: string,
  userId: string,
): Promise<AiCategorizationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { matched: false, reason: "OPENAI_API_KEY not configured" };
  }

  const target = matchTarget(merchant, descriptionRaw);
  if (!target) {
    return { matched: false, reason: "Nothing to categorize" };
  }

  const supabase = getSupabaseAdmin();

  // Fetch user's categories
  const { data: categories, error: catError } = await supabase
    .from("categories")
    .select("id, name")
    .eq("user_id", userId);

  if (catError || !categories || categories.length === 0) {
    return { matched: false, reason: "No categories found for user" };
  }

  const categoryOptions: CategoryOption[] = categories;
  const categoryList = categoryOptions.map((c) => c.name).join(", ");

  // Build the prompt
  const systemPrompt = `Sos un categorizador de gastos personales. Dado un merchant y descripción de una transacción bancaria, asigná UNA categoría de la lista proporcionada.

Categorías disponibles: ${categoryList}

Respondé SOLO un objeto JSON con esta forma:
{"category": "<nombre exacto de la lista>", "pattern": "<fragmento literal del texto>"}

Reglas:
- "category" tiene que ser el nombre exacto de la categoría, tal cual está en la lista.
- Si no podés categorizar con confianza, respondé {"category": "UNKNOWN", "pattern": ""}.
- "pattern" es el fragmento MÁS CORTO copiado TAL CUAL del texto que identifica al comercio o a la contraparte, y que sirva para reconocer futuras transacciones iguales. Copialo carácter por carácter: no lo reescribas, no lo traduzcas, no lo abrevies.
- El "pattern" NO puede ser texto genérico del banco ("Bancolombia le informa", "transferencia", "compra"), ni el monto, ni la fecha. Si no hay nada distintivo que copiar, devolvé "".
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

  const userMessage = `Merchant: "${merchant ?? "(sin merchant)"}"
Descripción: "${descriptionRaw}"`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        // Picking a name off a list and quoting a fragment needs no deliberation,
        // and reasoning tokens would eat the output cap.
        reasoning_effort: "none",
        response_format: { type: "json_object" },
        max_completion_tokens: 120,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return { matched: false, reason: `OpenAI API error: ${response.status}` };
    }

    const data = await response.json();
    const answer = parseAnswer(data.choices?.[0]?.message?.content);

    if (!answer || answer.category === "UNKNOWN") {
      return { matched: false, reason: "AI could not categorize" };
    }

    // Find matching category (case-insensitive)
    const matchedCategory = categoryOptions.find(
      (c) => c.name.toLowerCase() === answer.category.toLowerCase()
    );

    if (!matchedCategory) {
      return {
        matched: false,
        reason: `AI suggested "${answer.category}" which doesn't match any category`,
      };
    }

    // A merchant string is already the distinctive part, so the deterministic
    // extraction wins there. The AI's fragment is only needed when there is no
    // merchant and the counterparty is buried in the raw text.
    const candidate = merchant ? extractPattern(merchant) : answer.pattern;

    const autoRuleCreated =
      candidate !== null && candidate !== ""
        ? await createRule(candidate, target, matchedCategory, userId)
        : false;

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

/** The model is asked for JSON, but a wrapped or truncated body is still possible. */
function parseAnswer(content: unknown): { category: string; pattern: string } | null {
  if (typeof content !== "string" || content.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { category, pattern } = parsed as { category?: unknown; pattern?: unknown };
    if (typeof category !== "string" || category.trim() === "") return null;
    return {
      category: category.trim(),
      pattern: typeof pattern === "string" ? pattern.trim() : "",
    };
  } catch {
    return null;
  }
}

/**
 * Store an AI-authored rule, but only if it survives both signatures.
 * Returns whether the rule was created.
 */
async function createRule(
  pattern: string,
  source: string,
  category: CategoryOption,
  userId: string,
): Promise<boolean> {
  if (!isUsablePattern(pattern, source)) {
    console.log(`[ai-categorizer] rejected pattern "${pattern}": not a literal fragment`);
    return false;
  }

  if (await conflictsWithHistory(pattern, category.id, userId)) {
    console.log(`[ai-categorizer] rejected pattern "${pattern}": conflicts with history`);
    return false;
  }

  const { error } = await getSupabaseAdmin()
    .from("merchant_category_rules")
    .insert({
      user_id: userId,
      pattern,
      match_type: "ilike",
      category_id: category.id,
      priority: -10, // AI-generated: below manual rules (default 0) so human corrections always win
    });

  if (error) {
    console.error(`[ai-categorizer] rule insert failed for "${pattern}":`, error.message);
    return false;
  }

  console.log(`[ai-categorizer] Created rule: "${pattern}" → ${category.name}`);
  return true;
}

/**
 * Replay the pattern over the user's recent categorized transactions. If it hits
 * one that is already filed under a different category, the pattern is too broad
 * and is thrown away — the transaction still gets categorized, it just teaches
 * nothing.
 *
 * The match is done in JS with the very same substring test `categorize` uses,
 * so what is checked here is exactly what would happen at match time.
 */
async function conflictsWithHistory(
  pattern: string,
  categoryId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("transactions")
    .select("merchant, description_raw, category_id")
    .eq("user_id", userId)
    .not("category_id", "is", null)
    .neq("category_id", categoryId)
    .order("tx_date", { ascending: false })
    .limit(HISTORY_SAMPLE);

  // Fail closed: without history to check against, no rule is stored.
  if (error) {
    console.error("[ai-categorizer] history check failed:", error.message);
    return true;
  }
  if (!data) return true;

  const needle = pattern.toLowerCase();
  return data.some((tx) =>
    (matchTarget(tx.merchant, tx.description_raw) ?? "").toLowerCase().includes(needle)
  );
}
