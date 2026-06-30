/**
 * Whitelist of Android package names that contain financial notifications.
 * Only notifications from these packages get saved to push_raw_log and processed.
 * Everything else is rejected early to avoid storing noise.
 *
 * To add a new package: add it here and (optionally) create a parser in ./parsers/
 */
export const PACKAGE_WHITELIST = new Set([
  // Banking apps
  "com.todo1.mobile",                       // Bancolombia
  "com.bbva.nxt_argentina",                 // BBVA Argentina
  "com.nequi.MobileApp",                    // Nequi

  // Payment / card apps
  "com.grability.rappi",                    // Rappi / RappiCard
  "com.google.android.apps.walletnfcrel",   // Google Wallet (tap-to-pay)

  // Crypto / broker
  "com.nexowallet",                         // Nexo

  // SMS / messaging (bank alerts come via SMS too)
  "com.google.android.apps.messaging",      // Google Messages
  "com.samsung.android.messaging",          // Samsung Messages
  "com.android.mms",                        // AOSP SMS
]);

/** Returns true if the package is allowed through the ingest pipeline */
export function isWhitelistedPackage(packageName: string): boolean {
  return PACKAGE_WHITELIST.has(packageName);
}
