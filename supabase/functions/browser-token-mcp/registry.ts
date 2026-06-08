// =============================================================================
// browser-token-mcp — Provider module registry
// =============================================================================

import type { ProviderModule, ToolDefinition } from "./types.ts";

/** Registry of all provider modules, keyed by provider name */
const providers: Map<string, ProviderModule> = new Map();

/**
 * Register a provider module in the registry.
 * The module's `name` field is used as the registry key.
 */
export function register(module: ProviderModule): void {
  providers.set(module.name, module);
}

/**
 * Resolve a tool name to its owning provider module.
 * Routing logic: a tool name like `nexo_get_balances` has prefix `nexo_`
 * which matches a provider with name `nexo`.
 * Returns null if no provider matches the tool name prefix.
 */
export function resolveProvider(toolName: string): ProviderModule | null {
  for (const [name, module] of providers) {
    if (toolName.startsWith(`${name}_`)) {
      return module;
    }
  }
  return null;
}

/**
 * Aggregate all tools from all registered provider modules.
 * Used for the `tools/list` MCP response.
 */
export function allTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const module of providers.values()) {
    tools.push(...module.tools);
  }
  return tools;
}

/**
 * Check if a provider name is registered.
 * Used for refresh endpoint validation.
 */
export function isValidProvider(name: string): boolean {
  return providers.has(name);
}

/**
 * Return all registered provider names.
 * Used in error messages to list valid providers.
 */
export function validProviderNames(): string[] {
  return Array.from(providers.keys());
}
