import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { arriendoDef } from "../sources/arriendo";
import { htmlToText } from "../html-to-text";
import type { ParsedEmail } from "../types";

const FIXTURES_DIR = join(__dirname, "../__fixtures__");

function loadHtmlFixture(name: string): ParsedEmail {
  const html = readFileSync(join(FIXTURES_DIR, name), "utf-8");
  const bodyText = htmlToText(html);
  return {
    messageId: `msg-${name}`,
    internalDate: "1748736000000", // ~2025-06-01 in epoch ms
    subject: "Confirmación de Pago",
    bodyText,
  };
}

describe("Arriendo (Palomma) Gmail parser", () => {
  describe("buildQuery", () => {
    it("builds correct query for a given month", () => {
      const query = arriendoDef.buildQuery("2026-06");
      expect(query).toBe(
        'from:(info@palomma.com) subject:("Confirmación de Pago") after:2026/06/01 before:2026/07/01'
      );
    });

    it("handles December → January year rollover", () => {
      const query = arriendoDef.buildQuery("2026-12");
      expect(query).toBe(
        'from:(info@palomma.com) subject:("Confirmación de Pago") after:2026/12/01 before:2027/01/01'
      );
    });
  });

  describe("parse — aprobado email", () => {
    it("extracts correct candidate from aprobado fixture", () => {
      const email = loadHtmlFixture("arriendo-aprobado.html");
      const result = arriendoDef.parse(email);

      expect(result).toHaveLength(1);
      expect(result[0].amount_native).toBe(1900000);
      expect(result[0].native_currency).toBe("COP");
      expect(result[0].merchant).toBe("Arriendo");
      expect(result[0].tx_date).toBe("2026-06-01");
      expect(result[0].description_raw).toBe(
        "Canon Inmueble TV 32A SUR 31 E 47 AP 201 · Ref: 010863808323"
      );
      expect(result[0].account_name).toBe("Bancolombia Ahorros");
      expect(result[0].source).toBe("sync_gmail_arriendo");
      expect((result[0] as Record<string, unknown>).expense_type).toBe("fixed");
    });
  });

  describe("parse — discards", () => {
    it("returns [] when Estado is not Aprobado", () => {
      const bodyText = [
        "N. de transacción: 01KT2NW9TDHYFEMC7KY1A0JETS Fecha: 01/06/2026",
        "¡PAGO RECHAZADO!",
        "Arrendatario DANDREA ESCODA PATRICIO EDUARDO",
        "Descripción del pago Canon Inmueble TV 32A SUR 31 E 47 AP 201",
        "N. referencia 010863808323",
        "Estado Rechazado",
        "Método de pago Cuenta Bancolombia",
        "Valor total $ 1.900.000",
      ].join("\n");

      const email: ParsedEmail = {
        messageId: "msg-rejected",
        internalDate: "1748736000000",
        subject: "Confirmación de Pago",
        bodyText,
      };

      const result = arriendoDef.parse(email);
      expect(result).toEqual([]);
    });

    it("returns [] when Estado field is missing", () => {
      const bodyText = [
        "N. de transacción: 01KT2NW9TDHYFEMC7KY1A0JETS Fecha: 01/06/2026",
        "Descripción del pago Canon Inmueble TV 32A SUR 31 E 47 AP 201",
        "N. referencia 010863808323",
        "Valor total $ 1.900.000",
      ].join("\n");

      const email: ParsedEmail = {
        messageId: "msg-no-estado",
        internalDate: "1748736000000",
        subject: "Confirmación de Pago",
        bodyText,
      };

      const result = arriendoDef.parse(email);
      expect(result).toEqual([]);
    });
  });
});
