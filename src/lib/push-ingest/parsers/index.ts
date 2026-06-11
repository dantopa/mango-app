import { registerParser } from "../parser-registry";
import { bancolombiaParser } from "./bancolombia";
import { rappiParser } from "./rappi";
import { googleWalletParser } from "./google-wallet";
import { nexoParser } from "./nexo";
import { bbvaArgentinaParser } from "./bbva-argentina";
import { smsParser } from "./sms";

// Register all known parsers — package names confirmed from push_raw_log
registerParser("com.todo1.mobile", bancolombiaParser);
registerParser("com.grability.rappi", rappiParser);
registerParser("com.google.android.apps.walletnfcrel", googleWalletParser);
registerParser("com.nexowallet", nexoParser);
registerParser("com.bbva.nxt_argentina", bbvaArgentinaParser);

// SMS/messaging apps — try all financial parsers by content
registerParser("com.google.android.apps.messaging", smsParser);   // Google Messages
registerParser("com.samsung.android.messaging", smsParser);       // Samsung Messages
registerParser("com.android.mms", smsParser);                     // AOSP SMS

export { bancolombiaParser, rappiParser, googleWalletParser, nexoParser, bbvaArgentinaParser, smsParser };
