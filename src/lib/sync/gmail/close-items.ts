import { getSupabaseAdmin } from "../../push-ingest/supabase-admin";

const OWNER_USER_ID =
  process.env.MAQUINITA_OWNER_USER_ID ??
  "49b33f55-dcf2-4370-ba9a-204b91f2551d";

/**
 * Mark the monthly close item for a gmail sub-source as "cargado".
 *
 * Best-effort: never throws. If the monthly_close or item doesn't exist,
 * returns silently (cierre is optional).
 */
export async function markCloseItem(
  closeItemSource: string,
  month: string
): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();

    // 1. Find the monthly_close row for this period and owner
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: closeRow, error: closeError } = await (supabase as any)
      .from("monthly_close")
      .select("id")
      .eq("user_id", OWNER_USER_ID)
      .eq("period", month)
      .maybeSingle();

    if (closeError) {
      console.error(
        "[close-items] Error fetching monthly_close:",
        closeError.message
      );
      return;
    }

    // 2. No monthly_close for this period → return silently
    if (!closeRow) return;

    // 3. Find the matching monthly_close_items row
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: itemRow, error: itemError } = await (supabase as any)
      .from("monthly_close_items")
      .select("id")
      .eq("close_id", closeRow.id)
      .eq("item_type", "gmail_auto")
      .ilike("source", closeItemSource)
      .maybeSingle();

    if (itemError) {
      console.error(
        "[close-items] Error fetching monthly_close_items:",
        itemError.message
      );
      return;
    }

    // 4. Item not found → return silently
    if (!itemRow) return;

    // 5. Update status to 'cargado' with loaded_at = now()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateError } = await (supabase as any)
      .from("monthly_close_items")
      .update({ status: "cargado", loaded_at: new Date().toISOString() })
      .eq("id", itemRow.id);

    if (updateError) {
      console.error(
        "[close-items] Error updating monthly_close_items:",
        updateError.message
      );
    }
  } catch (err) {
    // Never throw — best-effort
    console.error(
      "[close-items] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
  }
}
