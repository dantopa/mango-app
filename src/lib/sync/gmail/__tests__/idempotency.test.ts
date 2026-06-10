import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * End-to-end idempotency tests for Gmail sync.
 *
 * **Validates: Requirements 5.4, 6.2, 7.3**
 *
 * Property 5 (Design §11): Process the same list of emails two times
 * (with Supabase mocked) → second run inserts 0.
 */

// --- Mocks ---

vi.mock("../client", () => ({
  refreshAccessToken: vi.fn().mockResolvedValue("mock-access-token"),
  listMessageIds: vi.fn(),
  getMessage: vi.fn(),
  GmailAuthError: class extends Error {
    code = "GMAIL_AUTH_REQUIRED" as const;
    constructor(msg: string) {
      super(msg);
      this.name = "GmailAuthError";
    }
  },
  GmailApiError: class extends Error {
    code = "GMAIL_API_ERROR" as const;
    constructor(msg: string) {
      super(msg);
      this.name = "GmailApiError";
    }
  },
}));

vi.mock("../../../push-ingest/supabase-admin", () => ({
  getSupabaseAdmin: vi.fn(),
}));

vi.mock("../../sync-engine", () => ({
  processCandidates: vi.fn(),
}));

vi.mock("../close-items", () => ({
  markCloseItem: vi.fn().mockResolvedValue(undefined),
}));

import { listMessageIds, getMessage } from "../client";
import { getSupabaseAdmin } from "../../../push-ingest/supabase-admin";
import { processCandidates } from "../../sync-engine";
import { runGmailMonth } from "../orchestrator";
import { gmailDedupKey } from "../orchestrator";
import type { SyncSourceResult } from "../../types";
import type { ParsedEmail } from "../types";

// --- Test helpers ---

function createMockSupabase(processedKeys: Set<string>) {
  return {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockImplementation((_col: string, keys: string[]) => {
      const existing = keys.filter((k) => processedKeys.has(k));
      return Promise.resolve({
        data: existing.map((k) => ({ dedup_key: k })),
        error: null,
      });
    }),
    upsert: vi.fn().mockImplementation((row: { dedup_key: string }) => {
      // Simulate persisting the key
      processedKeys.add(row.dedup_key);
      return Promise.resolve({ error: null });
    }),
  };
}

const ARRIENDO_EMAIL: ParsedEmail = {
  messageId: "arriendo-msg-001",
  internalDate: "1717200000000",
  subject: "Confirmación de Pago",
  bodyText: [
    "N. de transacción: 01KT2NW9TDHYFEMC7KY1A0JETS   Fecha: 01/06/2026",
    "¡PAGO APROBADO!",
    "Arrendatario: TEST USER",
    "Descripción del pago: Canon Inmueble TV 32A SUR 31 E 47 AP 201",
    "N. referencia: 010863808323",
    "Estado Aprobado",
    "Método de pago: Cuenta Bancolombia",
    "Valor total $ 1.900.000",
  ].join("\n"),
};

const BANCOLOMBIA_PALOMMA_EMAIL: ParsedEmail = {
  messageId: "bncol-msg-002",
  internalDate: "1717200000000",
  subject: "Alertas y Notificaciones",
  bodyText:
    "Transferiste $1900000.00 por Boton Bancolombia a PALOMMA SAS desde producto *9898. 01/06/2026 17:48:13.",
};

const BANCOLOMBIA_COMPRA_EMAIL: ParsedEmail = {
  messageId: "bncol-msg-003",
  internalDate: "1717250000000",
  subject: "Alertas y Notificaciones",
  bodyText:
    "Bancolombia: Compraste $75000.00 en EXITO COLOMBIA con tu T.Deb *5685, el 05/06/2026 a las 10:30.",
};

describe("End-to-end idempotency (Property 5)", () => {
  let processedKeys: Set<string>;
  let mockSupabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    processedKeys = new Set<string>();
    mockSupabase = createMockSupabase(processedKeys);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);
  });

  it("second run inserts 0 when processing the same emails twice", async () => {
    // Setup: listMessageIds returns 2 messages for bancolombia, 0 for others
    vi.mocked(listMessageIds).mockImplementation(
      async (_token: string, query: string) => {
        if (query.includes("an.notificacionesbancolombia.com")) {
          return {
            messageIds: ["bncol-msg-003", "bncol-msg-004"],
            nextPageToken: null,
          };
        }
        return { messageIds: [], nextPageToken: null };
      }
    );

    // Setup: getMessage returns fixture-like emails
    const email2: ParsedEmail = {
      messageId: "bncol-msg-004",
      internalDate: "1717300000000",
      subject: "Alertas y Notificaciones",
      bodyText:
        "Pagaste $359702.00 a EMPRESAS PUBLICAS DE MEDELLIN desde tu producto 9898 el 06/06/2026 02:41:55.",
    };

    vi.mocked(getMessage).mockImplementation(
      async (_token: string, id: string) => {
        if (id === "bncol-msg-003") return BANCOLOMBIA_COMPRA_EMAIL;
        if (id === "bncol-msg-004") return email2;
        throw new Error(`Unexpected message ID: ${id}`);
      }
    );

    // Setup: processCandidates simulates successful insertion on first run
    vi.mocked(processCandidates).mockResolvedValue({
      source: "sync_gmail_bancolombia",
      found: 1,
      inserted: 1,
      duplicates: 0,
      needs_review: 0,
      errors: [],
    });

    // --- FIRST RUN ---
    await runGmailMonth("2026-06");

    // After first run, processCandidates should have been called (emails were new)
    expect(vi.mocked(processCandidates)).toHaveBeenCalled();
    const firstProcessCalls = vi.mocked(processCandidates).mock.calls.length;
    expect(firstProcessCalls).toBeGreaterThan(0);

    // Verify dedup keys were stored
    expect(processedKeys.has(gmailDedupKey("bncol-msg-003"))).toBe(true);
    expect(processedKeys.has(gmailDedupKey("bncol-msg-004"))).toBe(true);

    // --- SECOND RUN ---
    vi.mocked(processCandidates).mockClear();

    const secondResult = await runGmailMonth("2026-06");

    // filterAlreadyProcessed should return empty → processCandidates NOT called
    expect(vi.mocked(processCandidates)).not.toHaveBeenCalled();

    // The bancolombia result in second run should show all as duplicates
    const bancoResult = secondResult.results.find(
      (r) => r.source === "sync_gmail_bancolombia"
    );
    expect(bancoResult).toBeDefined();
    expect(bancoResult!.duplicates).toBe(2);
    expect(bancoResult!.inserted).toBe(0);
  });

  it("Palomma/Bancolombia cross-source dedup: arriendo runs first, bancolombia deduplicates", async () => {
    // Setup: arriendo source returns the Palomma email
    // bancolombia source returns the transfer to PALOMMA SAS
    vi.mocked(listMessageIds).mockImplementation(
      async (_token: string, query: string) => {
        if (query.includes("palomma.com")) {
          return { messageIds: ["arriendo-msg-001"], nextPageToken: null };
        }
        if (query.includes("an.notificacionesbancolombia.com")) {
          return { messageIds: ["bncol-msg-002"], nextPageToken: null };
        }
        // rappicard returns nothing
        return { messageIds: [], nextPageToken: null };
      }
    );

    vi.mocked(getMessage).mockImplementation(
      async (_token: string, id: string) => {
        if (id === "arriendo-msg-001") return ARRIENDO_EMAIL;
        if (id === "bncol-msg-002") return BANCOLOMBIA_PALOMMA_EMAIL;
        throw new Error(`Unexpected message ID: ${id}`);
      }
    );

    // processCandidates: arriendo inserts successfully
    // bancolombia: simulates dedup catching the duplicate (same amount+date)
    let arriendoCallCount = 0;
    vi.mocked(processCandidates).mockImplementation(async (candidates) => {
      const source = candidates[0]?.source;

      if (source === "sync_gmail_arriendo") {
        arriendoCallCount++;
        return {
          source: "sync_gmail_arriendo",
          found: 1,
          inserted: 1,
          duplicates: 0,
          needs_review: 0,
          errors: [],
        } as SyncSourceResult;
      }

      if (source === "sync_gmail_bancolombia") {
        // Dedup catches it: the same amount+date already exists from arriendo
        return {
          source: "sync_gmail_bancolombia",
          found: 1,
          inserted: 0,
          duplicates: 1,
          needs_review: 0,
          errors: [],
        } as SyncSourceResult;
      }

      return {
        source: source ?? "sync_gmail_bancolombia",
        found: 0,
        inserted: 0,
        duplicates: 0,
        needs_review: 0,
        errors: [],
      } as SyncSourceResult;
    });

    const result = await runGmailMonth("2026-06");

    // Arriendo should have been processed first (due to source order)
    expect(arriendoCallCount).toBe(1);

    // Verify arriendo result
    const arriendoResult = result.results.find(
      (r) => r.source === "sync_gmail_arriendo"
    );
    expect(arriendoResult).toBeDefined();
    expect(arriendoResult!.inserted).toBe(1);

    // Verify bancolombia result: the PALOMMA transfer was caught as duplicate
    const bancoResult = result.results.find(
      (r) => r.source === "sync_gmail_bancolombia"
    );
    expect(bancoResult).toBeDefined();
    expect(bancoResult!.duplicates).toBe(1);
    expect(bancoResult!.inserted).toBe(0);

    // The source execution order is arriendo → rappicard → bancolombia
    // So processCandidates was called for arriendo BEFORE bancolombia
    const processCalls = vi.mocked(processCandidates).mock.calls;
    const arriendoCallIdx = processCalls.findIndex(
      (call) => call[0][0]?.source === "sync_gmail_arriendo"
    );
    const bancoCallIdx = processCalls.findIndex(
      (call) => call[0][0]?.source === "sync_gmail_bancolombia"
    );
    expect(arriendoCallIdx).toBeLessThan(bancoCallIdx);
  });
});
