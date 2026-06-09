import { registerParser } from "../parser-registry";
import { bancolombiaParser } from "./bancolombia";
import { rappiParser } from "./rappi";
import { googleWalletParser } from "./google-wallet";
import { nexoParser } from "./nexo";

// Register all known parsers
// Package names are tentative — confirm with real device
registerParser("com.todo1.mobile", bancolombiaParser);
registerParser("com.grability.rappi", rappiParser);
registerParser("com.google.android.apps.walletnfcrel", googleWalletParser);
registerParser("com.nexo.wallet", nexoParser);

export { bancolombiaParser, rappiParser, googleWalletParser, nexoParser };
