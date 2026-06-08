// =============================================================================
// browser-token-mcp — Vault abstraction
// =============================================================================
// Reads and writes provider session tokens from/to Supabase Vault.
// Vault key pattern: `provider:{name}:token`
// Uses service role key for full access to vault.decrypted_secrets view.
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { VaultEmptyError, VaultServiceError, VaultWriteError } from "./types.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

/** Vault key for a given provider */
function vaultKey(provider: string): string {
  return `provider:${provider.toLowerCase()}:token`;
}

/**
 * Read a provider's session token from Supabase Vault.
 * Uses raw SQL via supabase.rpc since PostgREST doesn't expose the vault schema.
 * Enforces a 5-second timeout on the read operation.
 *
 * @throws VaultEmptyError if no token is stored for the provider
 * @throws VaultServiceError if the read operation fails or times out
 */
export async function readToken(provider: string): Promise<string> {
  const key = vaultKey(provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const { data, error } = await supabase.rpc("vault_read_secret", {
      secret_name: key,
    }).abortSignal(controller.signal);

    if (error) {
      // Check if it's a "function not found" error — means we need to create the helper
      if (error.message?.includes("vault_read_secret")) {
        throw new VaultServiceError("Vault helper function not found");
      }
      throw new VaultServiceError();
    }

    if (!data) {
      throw new VaultEmptyError(provider);
    }

    return data as string;
  } catch (err) {
    if (err instanceof VaultEmptyError || err instanceof VaultServiceError) {
      throw err;
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new VaultServiceError("Vault read timed out after 5 seconds");
    }
    throw new VaultServiceError();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Write (upsert) a provider's session token to Supabase Vault.
 * Creates a new secret if none exists, or updates the existing one.
 * Uses a helper RPC function for vault access.
 *
 * @throws VaultWriteError if the write operation fails
 */
export async function writeToken(provider: string, token: string): Promise<void> {
  const key = vaultKey(provider);

  try {
    const { error } = await supabase.rpc("vault_write_secret", {
      secret_name: key,
      secret_value: token,
    });

    if (error) {
      throw new VaultWriteError();
    }
  } catch (err) {
    if (err instanceof VaultWriteError) {
      throw err;
    }
    throw new VaultWriteError();
  }
}
