import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { bancolombiaDef } from "../sources/bancolombia";
import type { ParsedEmail } from "../types";

const FIXTURES_DIR = join(__dirname, "../__fixtures__");

function loadFixture(name: string): ParsedEmail {
  const bodyText = readFileSync(join(FIXTURES_DIR, name), "utf-8");
  return {
    messageId: `msg-${name}`,
    internalDate: "1717700000000",
    subject: "Alertas y Notificaciones",
    bodyText,
  };
}

describe("Bancolombia Gmail parser", () => {
  describe("buildQuery", () => {
    it("builds correct query for a given month", () => {
      const query = bancolombiaDef.buildQuery("2026-06");
      expect(query).toBe(
        "from:(an.notificacionesbancolombia.com) after:2026/06/01 before:2026/07/01"
      );
    });

    it("handles December → January year rollover", () => {
      const query = bancolombiaDef.buildQuery("2026-12");
      expect(query).toBe(
        "from:(an.notificacionesbancolombia.com) after:2026/12/01 before:2027/01/01"
      );
    });
  });

  describe("parse — transaction variants", () => {
    it("COMPRA: extracts amount, merchant, and date", () => {
      const email = loadFixture("bancolombia-compra.txt");
      const result = bancolombiaDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].amount_native).toBe(7500);
      expect(result[0].merchant).toBe("PERGAMINO VIVA ENVIG");
      expect(result[0].tx_date).toBe("2026-06-09");
      expect(result[0].native_currency).toBe("COP");
      expect(result[0].source).toBe("sync_gmail_bancolombia");
      // Same physical account as the push ingest: the separate "Bancolombia
      // Débito" row was merged into savings.
      expect(result[0].account_name).toBe("Bancolombia Ahorros");
    });

    it("PAGO SERVICIO: extracts beneficiary as merchant", () => {
      const email = loadFixture("bancolombia-pago-servicio.txt");
      const result = bancolombiaDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].amount_native).toBe(359702);
      expect(result[0].merchant).toBe("EMPRESAS PUBLICAS DE MEDELLIN");
      expect(result[0].tx_date).toBe("2026-06-06");
    });

    it("QR: emits candidate with null merchant (llave numérica)", () => {
      const email = loadFixture("bancolombia-qr.txt");
      const result = bancolombiaDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].amount_native).toBe(25000);
      expect(result[0].merchant).toBeNull();
      expect(result[0].tx_date).toBe("2026-06-06");
    });

    it("BRE-B LLAVE: extracts destination name as merchant", () => {
      const email = loadFixture("bancolombia-breb-llave.txt");
      const result = bancolombiaDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].amount_native).toBe(3000);
      expect(result[0].merchant).toBe("NANCY BEATRIZ HENAO HENAO");
      expect(result[0].tx_date).toBe("2026-05-25");
    });

    it("TRANSFERENCIA: extracts destination account as merchant", () => {
      const email = loadFixture("bancolombia-transferencia.txt");
      const result = bancolombiaDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].amount_native).toBe(100000);
      expect(result[0].merchant).toBe("Cuenta *34238965219");
      expect(result[0].tx_date).toBe("2026-06-08");
    });

    it("BOTON: extracts destinatario as merchant", () => {
      const email = loadFixture("bancolombia-boton.txt");
      const result = bancolombiaDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].amount_native).toBe(1900000);
      expect(result[0].merchant).toBe("PALOMMA SAS");
      expect(result[0].tx_date).toBe("2026-06-01");
    });

    it("INGRESO: negative amount and sender as merchant", () => {
      const email = loadFixture("bancolombia-ingreso.txt");
      const result = bancolombiaDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].amount_native).toBe(-970000);
      expect(result[0].is_income).toBe(true);
      expect(result[0].merchant).toBe("SUPRA NEGOCIOS SAS");
      expect(result[0].tx_date).toBe("2026-06-05");
    });

    // El text/plain real viene cortado a 72 columnas y bodyText lo prefiere sobre
    // el HTML, así que la frase llega partida. Con espacios literales en el regex
    // no se detectaba ni un ingreso, y todos caían al camino de la IA.
    it("INGRESO: también cuando el text/plain corta la frase en dos líneas", () => {
      const email = loadFixture("bancolombia-ingreso-wrapped.txt");
      expect(email.bodyText).toContain("recibiste una\ntransferencia");

      const result = bancolombiaDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].amount_native).toBe(-100000);
      expect(result[0].is_income).toBe(true);
      expect(result[0].merchant).toBe("SUPRA NEGOCIOS SAS");
      expect(result[0].tx_date).toBe("2026-08-15");
    });

    it("GASTO: no marca is_income en una compra", () => {
      const result = bancolombiaDef.parse(loadFixture("bancolombia-compra.txt"));

      expect(result[0].is_income).toBeUndefined();
    });
  });

  describe("parse — discards", () => {
    it("NO-TX: returns [] for non-transactional emails", () => {
      const email = loadFixture("bancolombia-no-tx.txt");
      const result = bancolombiaDef.parse(email);

      expect(result).toEqual([]);
    });
  });
});
