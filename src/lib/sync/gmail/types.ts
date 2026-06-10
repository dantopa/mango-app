import type { CandidateTransaction, SyncSource, SyncSourceResult } from "../types";

export type GmailSourceId = "bancolombia" | "rappicard" | "arriendo";

/** Una fuente Gmail = query + parser. Agregar fuente nueva = un archivo nuevo. */
export interface GmailSourceDef {
  id: GmailSourceId;
  syncSource: SyncSource;
  accountName: string;
  closeItemSource: string | null;
  buildQuery(month: string): string;
  parse(email: ParsedEmail): CandidateTransaction[];
}

export interface ParsedEmail {
  messageId: string;
  internalDate: string;
  subject: string;
  bodyText: string;
}

export interface GmailSyncCursor {
  source: GmailSourceId;
  pageToken?: string;
}

export interface GmailSyncResponse {
  results: SyncSourceResult[];
  next: GmailSyncCursor | null;
}
