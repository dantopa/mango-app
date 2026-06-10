import type { GmailSourceDef } from "../types";
import { arriendoDef } from "./arriendo";
import { rappicardDef } from "./rappicard";
import { bancolombiaDef } from "./bancolombia";

/**
 * Gmail sources in execution order.
 * arriendo → rappicard → bancolombia
 * (arriendo first for dedup: its richer metadata takes priority over
 * the Bancolombia "Transferiste a PALOMMA SAS" email)
 */
export const GMAIL_SOURCES: GmailSourceDef[] = [
  arriendoDef,
  rappicardDef,
  bancolombiaDef,
];
