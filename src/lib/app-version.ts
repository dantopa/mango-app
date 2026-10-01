/**
 * Which build of the app is running, and whether a newer one is deployed.
 *
 * The Android app is a Trusted Web Activity: it shows whatever is deployed,
 * but a session resumed from the background keeps running the code it loaded,
 * possibly days ago. Comparing the build baked into this bundle with the one
 * the server reports is what tells the owner there is something newer.
 */

/** Commit this bundle was built from ("dev" outside Vercel). */
export const CURRENT_BUILD = process.env.NEXT_PUBLIC_BUILD_ID || "dev";

/** When this bundle was built (ISO), or null when unknown. */
export const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME || null;

/** Key under which the last build the owner saw is remembered. */
export const LAST_SEEN_BUILD_KEY = "maquinita:last-seen-build";

/** Short commit, the way GitHub shows it. */
export function shortBuild(build: string): string {
  return /^[0-9a-f]{40}$/i.test(build) ? build.slice(0, 7) : build;
}

/** True when the server reports a different build than the one running. */
export function isNewerBuild(current: string, latest: string | null | undefined): boolean {
  if (!latest || latest === "dev" || current === "dev") return false;
  return latest !== current;
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Remembers the running build and returns the previous one when it changed —
 * i.e. the app was just updated. Returns null on first run (nothing to compare
 * with), when nothing changed, or when storage is unavailable.
 */
export function takeUpdatedFrom(storage: KeyValueStorage | null, current: string = CURRENT_BUILD): string | null {
  if (!storage || current === "dev") return null;
  try {
    const previous = storage.getItem(LAST_SEEN_BUILD_KEY);
    if (previous !== current) storage.setItem(LAST_SEEN_BUILD_KEY, current);
    return previous && previous !== current ? previous : null;
  } catch {
    return null;
  }
}

/** "1 oct 2026, 01:18" in Bogotá time. */
export function formatBuildTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
