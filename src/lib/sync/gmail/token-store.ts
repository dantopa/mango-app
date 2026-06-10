import { getSupabaseAdmin } from "../../push-ingest/supabase-admin";

const SECRET_NAME = "gmail_refresh_token";

/**
 * Helper to call Vault RPCs that aren't in the generated Database types.
 * The RPCs exist in Postgres (migrated) but supabase-gen-types doesn't pick up
 * SECURITY DEFINER functions revoked from anon/authenticated.
 */
function adminRpc() {
  return getSupabaseAdmin() as unknown as {
    rpc: (
      fn: string,
      params: Record<string, string>,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
}

/**
 * Store (or update) the Gmail refresh token in Supabase Vault.
 * Uses the service-role admin client so the RPC succeeds (revoked for anon/authenticated).
 */
export async function storeRefreshToken(token: string): Promise<void> {
  const { error } = await adminRpc().rpc("vault_upsert_secret", {
    p_name: SECRET_NAME,
    p_secret: token,
  });
  if (error) {
    throw new Error(`Failed to store refresh token: ${error.message}`);
  }
}

/**
 * Retrieve the Gmail refresh token from Supabase Vault.
 * Returns null if no token has been stored yet.
 */
export async function getRefreshToken(): Promise<string | null> {
  const { data, error } = await adminRpc().rpc("vault_get_secret", {
    p_name: SECRET_NAME,
  });
  if (error) {
    throw new Error(`Failed to retrieve refresh token: ${error.message}`);
  }
  return (data as string | null) ?? null;
}
