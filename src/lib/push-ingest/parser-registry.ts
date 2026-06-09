import type { ParserFn } from "./types";

/** Map of Android package name → parser function */
const registry: Map<string, ParserFn> = new Map();

/** Register a parser for a package name */
export function registerParser(packageName: string, parser: ParserFn): void {
  registry.set(packageName, parser);
}

/** Get the parser for a package name, or undefined if not registered */
export function getParser(packageName: string): ParserFn | undefined {
  return registry.get(packageName);
}

/** Get all registered package names */
export function getRegisteredPackages(): string[] {
  return Array.from(registry.keys());
}
