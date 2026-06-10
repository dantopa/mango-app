# Implementation Plan: Browser Token MCP

## Overview

Implementación de un MCP server genérico como Supabase Edge Function que permite a Claude acceder a plataformas sin API oficial usando session tokens extraídos del navegador. El primer provider es Nexo (crypto). La función usa Deno runtime con módulos separados para routing, protocolo MCP, refresh de tokens, vault, registry, seguridad, y providers.

## Tasks

- [x] 1. Set up project structure, types, and security utilities
  - [x] 1.1 Create shared types and interfaces (`types.ts`)
    - Create `supabase/functions/browser-token-mcp/types.ts`
    - Define `NexoSessionToken`, `ProviderModule`, `ToolDefinition`, `ToolResult`, `RefreshRequest`, `RefreshResponse` interfaces
    - Define custom error classes: `VaultEmptyError`, `VaultServiceError`, `VaultWriteError`
    - _Requirements: 5.1, 4.1_

  - [x] 1.2 Create security utilities (`security.ts`)
    - Create `supabase/functions/browser-token-mcp/security.ts`
    - Implement `timingSafeEqual(a, b)` using constant-time comparison to prevent timing attacks
    - Implement `redactToken(text, token)` that replaces any 4+ char substring of the token found in text with `[REDACTED]`
    - Implement `sanitizeError(error)` that strips stack traces, file paths, and limits output to 500 chars
    - _Requirements: 2.5, 10.3, 10.6, 9.3_

  - [x]* 1.3 Write property tests for security utilities
    - **Property 16: Error Message Sanitization** — verify sanitized output never contains stack traces or file paths and is ≤ 500 chars
    - **Property 18: Token Never Exposed in Responses** — verify `redactToken` removes all 4+ char substrings of the token
    - **Validates: Requirements 9.3, 10.3**

- [x] 2. Implement Vault abstraction and provider registry
  - [x] 2.1 Create Vault abstraction (`vault.ts`)
    - Create `supabase/functions/browser-token-mcp/vault.ts`
    - Implement `readToken(provider)` that queries `vault.decrypted_secrets` by name pattern `provider:{name}:token` with 5-second timeout
    - Implement `writeToken(provider, token)` that upserts via vault SQL functions
    - Throw `VaultEmptyError` when slot is empty, `VaultServiceError` on read failure, `VaultWriteError` on write failure
    - Use `createClient` from `jsr:@supabase/supabase-js@2` with service role key
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 2.2 Create provider registry (`registry.ts`)
    - Create `supabase/functions/browser-token-mcp/registry.ts`
    - Implement `register(module)` to add a ProviderModule to the registry Map
    - Implement `resolveProvider(toolName)` that matches by tool name prefix (e.g., `nexo_` → Nexo provider)
    - Implement `allTools()` to aggregate all tools from all registered modules
    - Implement `isValidProvider(name)` and `validProviderNames()` for refresh validation
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [x]* 2.3 Write property tests for registry
    - **Property 2: Tools List Completeness** — for any set of registered modules, `allTools()` length equals sum of each module's tools
    - **Property 3: Dispatch Routing Correctness** — for any tool name matching a registered prefix, `resolveProvider` returns the correct module
    - **Property 4: Unknown Tool Rejection** — for any string not matching any tool name, `resolveProvider` returns null
    - **Validates: Requirements 1.3, 5.2, 5.3, 5.5**

- [x] 3. Checkpoint — Ensure foundation modules compile
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement MCP protocol handler and refresh endpoint
  - [x] 4.1 Create MCP protocol handler (`mcp.ts`)
    - Create `supabase/functions/browser-token-mcp/mcp.ts`
    - Export `mcpHandler(req)` that validates `BROWSER_MCP_SECRET` via constant-time compare
    - Return HTTP 500 with JSON-RPC error if `BROWSER_MCP_SECRET` env var is unset/empty
    - Parse JSON body → return JSON-RPC error -32700 on invalid JSON
    - Handle methods: `initialize` (return serverInfo name `"browser-token-mcp"`, protocolVersion `"2024-11-05"`, capabilities `{tools: {}}`), `tools/list`, `tools/call`, `ping`, notifications
    - For `tools/call`: resolve provider via registry, read token from Vault, call provider handler, wrap errors with redaction
    - Return JSON-RPC error -32601 for unknown methods
    - Accept auth via `Authorization: Bearer <token>` header or `key` query param (header takes priority)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 5.2, 5.7, 9.4, 9.5, 9.6_

  - [x] 4.2 Create refresh endpoint handler (`refresh.ts`)
    - Create `supabase/functions/browser-token-mcp/refresh.ts`
    - Export `refreshHandler(req)` that validates `BROWSER_MCP_REFRESH_SECRET` via constant-time compare
    - Validate Content-Type is `application/json` → 415 if not
    - Reject body > 10KB or invalid JSON → 400
    - Validate `provider` against registry → 400 with valid provider names if unknown
    - Validate `token` field: not empty/whitespace, ≤ 8192 chars → 400 if invalid
    - Store token in Vault via `writeToken` → 502 on Vault write failure (no internal details)
    - Return 200 with `{provider, updated_at}` on success
    - Ensure Refresh_Secret is distinct from Shared_Secret and reject Shared_Secret
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_

  - [x]* 4.3 Write property tests for MCP handler
    - **Property 1: JSON-RPC Response Structure Invariant** — every valid POST with valid auth returns JSON with `jsonrpc: "2.0"`, matching `id`, and `result` or `error` (never both)
    - **Property 5: CORS Headers Invariant** — every response includes the three required CORS headers
    - **Property 7: Invalid MCP Authentication Rejection** — any string ≠ BROWSER_MCP_SECRET is rejected with 401
    - **Property 17: Error Structure Consistency** — all error conditions return `isError: true` + `content` array with text item
    - **Validates: Requirements 1.1, 1.6, 2.1, 2.5, 9.6**

  - [x]* 4.4 Write property tests for refresh handler
    - **Property 9: Invalid Refresh Authentication Rejection** — any string ≠ BROWSER_MCP_REFRESH_SECRET is rejected with 401
    - **Property 10: Invalid Provider Name Rejection** — unregistered provider names get 400 with valid names listed
    - **Property 11: Invalid Token Body Rejection** — empty, whitespace-only, or >8192 char tokens get 400
    - **Property 12: Refresh Success Response Format** — successful refreshes return provider name + ISO 8601 UTC timestamp
    - **Property 13: Oversized or Invalid Request Body Rejection** — bodies >10KB or non-JSON get 400
    - **Validates: Requirements 3.3, 3.4, 3.5, 3.6, 3.7, 3.10**

- [x] 5. Implement entry point router and Nexo provider
  - [x] 5.1 Create entry point router (`index.ts`)
    - Create `supabase/functions/browser-token-mcp/index.ts`
    - Use `Deno.serve()` as entry point
    - Handle OPTIONS → 204 + CORS headers
    - Reject non-POST/OPTIONS → 405
    - Route: URL path ends with `/refresh` → `refreshHandler`
    - Default route → `mcpHandler`
    - Include CORS headers on ALL responses: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization`
    - Register provider modules (import and register nexoProvider)
    - _Requirements: 1.6, 1.7, 1.8, 3.1_

  - [x] 5.2 Implement Nexo provider module (`providers/nexo.ts`)
    - Create `supabase/functions/browser-token-mcp/providers/nexo.ts`
    - Export `nexoProvider: ProviderModule` with name `"nexo"`
    - Declare `nexo_get_balances` tool with no required params and read-only description
    - In handler: parse token JSON → `NexoSessionToken`, construct HTTP POST to `https://platform.nexo.com/api/1/get_balances`
    - Set cookies: `JSESSIONID={jsessionid}; nsi={nsi}; esi={esi}`
    - Set headers: `x-nexo-installation-id`, `correlationid` (random UUID), `platform-name: Web`, `origin`, `referer`, `content-type: application/json`
    - 15-second request timeout via AbortController
    - Handle 2xx: parse balances, return structured list (currency, available, total)
    - Handle 401/403: return `isError: true` with token expiry message including provider name and re-auth instruction
    - Handle other non-2xx: return `isError: true` with status code and error detail
    - Handle network/timeout errors: return `isError: true` without exposing credentials
    - Apply token redaction on all error messages before returning
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 6.1, 6.2, 6.3, 8.1, 8.2, 10.1, 10.2, 10.5_

  - [x]* 5.3 Write property tests for Nexo provider
    - **Property 14: Token Expiry Detection** — 401/403 responses result in `isError: true` with provider name and re-auth instruction, no retry
    - **Property 15: Provider Error Forwarding** — non-2xx (other than 401/403) includes HTTP status code and error message
    - **Property 18: Token Never Exposed in Responses** — token value never appears in any tool result content
    - **Validates: Requirements 6.1, 6.2, 6.3, 9.1, 9.2, 10.1, 10.3**

- [x] 6. Checkpoint — Ensure MCP server functions correctly end-to-end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Create token extractor bookmarklet and database migration
  - [x] 7.1 Create Supabase Vault migration
    - Create a SQL migration file in `supabase/migrations/` to ensure the `vault` extension is enabled (`create extension if not exists supabase_vault with schema vault`)
    - Grant necessary permissions for the service role to access `vault.secrets` and `vault.decrypted_secrets`
    - _Requirements: 4.6_

  - [x] 7.2 Create token extractor bookmarklet HTML page
    - Create `supabase/functions/browser-token-mcp/bookmarklet.html` (or a separate static file)
    - Build a bookmarklet JavaScript that when run on `platform.nexo.com`:
      - Extracts `JSESSIONID`, `nsi`, `esi` cookies from `document.cookie`
      - Extracts `installation_id` from localStorage or page state
      - Constructs the JSON token object
      - Sends POST to the refresh endpoint with `Authorization: Bearer REFRESH_SECRET` and the token body
      - Shows success/failure feedback to the user
    - Include instructions for the user on how to install and use the bookmarklet
    - _Requirements: 3.1, 3.2_

  - [x]* 7.3 Write unit tests for Vault abstraction
    - Test `readToken` returns token when vault has data
    - Test `readToken` throws `VaultEmptyError` when slot is empty
    - Test `readToken` throws `VaultServiceError` on query failure
    - Test `writeToken` upserts correctly
    - Test `writeToken` throws `VaultWriteError` on failure
    - Mock Supabase client SQL queries
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 8. Integration wiring and final validation
  - [x] 8.1 Wire all modules together and verify end-to-end flow
    - Ensure `index.ts` imports and registers the nexo provider via `registry.ts`
    - Verify the full flow: push token via `/refresh` → call `nexo_get_balances` via `/mcp` → get structured result
    - Verify error flows: missing token in vault, expired token (401), invalid auth on both endpoints
    - Confirm CORS headers present on all response types (success, error, OPTIONS)
    - Confirm no token leakage in any response
    - _Requirements: 1.1–1.8, 2.1–2.5, 3.1–3.10, 4.1–4.6, 5.1–5.7, 6.1–6.3, 7.1–7.7, 8.1–8.2, 9.1–9.7, 10.1–10.5_

  - [x]* 8.2 Write integration tests
    - **Property 8: Token Refresh Round-Trip** — push token via refresh, invoke tool, verify tool receives the same token
    - Test full happy path: refresh → tool call → structured response
    - Test token update: push new token → verify new token is used in subsequent calls
    - Test auth isolation: MCP secret rejected on refresh endpoint and vice versa
    - **Validates: Requirements 3.2, 3.8, 4.1, 4.2**

- [x] 9. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation uses TypeScript on Deno runtime (`jsr:@supabase/supabase-js@2`)
- The existing `maquinita-mcp/index.ts` serves as reference for patterns (CORS, `Deno.serve()`, JSON-RPC helpers)
- Environment secrets `BROWSER_MCP_SECRET` and `BROWSER_MCP_REFRESH_SECRET` must be configured in Supabase dashboard before deployment

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "2.2"] },
    { "id": 2, "tasks": ["2.3", "4.1", "4.2"] },
    { "id": 3, "tasks": ["4.3", "4.4", "5.1", "5.2"] },
    { "id": 4, "tasks": ["5.3", "7.1", "7.2"] },
    { "id": 5, "tasks": ["7.3", "8.1"] },
    { "id": 6, "tasks": ["8.2"] }
  ]
}
```
