// =============================================================================
// browser-token-mcp — Shared types and interfaces
// =============================================================================

// --- JSON Schema type (simplified for tool input schemas) ---------------------

/** JSON Schema subset used for tool input definitions */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema & { description?: string }>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: string[];
}

// --- Provider token types ----------------------------------------------------

/** Stored in Vault as JSON string for Nexo (key: provider:nexo:token) */
export interface NexoSessionToken {
  jsessionid: string;
  nsi: string;
  esi: string;
  installation_id: string;
}

// --- Provider module interface -----------------------------------------------

/** Generic interface for all provider modules */
export interface ProviderModule {
  /** Unique provider name (lowercase, matches vault key) */
  name: string;
  /** Tools this provider exposes */
  tools: ToolDefinition[];
  /** Execute a tool with given params and session token */
  handle(
    toolName: string,
    params: Record<string, unknown>,
    token: string,
  ): Promise<ToolResult>;
}

// --- Tool types --------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// --- Refresh endpoint types --------------------------------------------------

export interface RefreshRequest {
  provider: string;
  token: string;
}

export interface RefreshResponse {
  provider: string;
  updated_at: string; // ISO 8601 UTC
}

// --- Custom error classes ----------------------------------------------------

/** Thrown when a Vault slot for a provider is empty (no token stored) */
export class VaultEmptyError extends Error {
  constructor(provider: string) {
    super(
      `No token configured for provider '${provider}'. ` +
        `Please push a token via the refresh endpoint.`,
    );
    this.name = "VaultEmptyError";
  }
}

/** Thrown when the Vault service is unreachable or returns an error on read */
export class VaultServiceError extends Error {
  constructor(message = "Internal storage error") {
    super(message);
    this.name = "VaultServiceError";
  }
}

/** Thrown when writing a token to Vault fails */
export class VaultWriteError extends Error {
  constructor(message = "Token storage failed") {
    super(message);
    this.name = "VaultWriteError";
  }
}
