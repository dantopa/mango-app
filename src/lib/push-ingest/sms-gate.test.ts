import { describe, expect, it } from "vitest";

import { allowedSenders, checkSms, normalizeSender } from "./sms-gate";

const MESSAGES = "com.google.android.apps.messaging";

describe("checkSms", () => {
  it("lets through a purchase alert from a Bancolombia short code", () => {
    expect(checkSms(MESSAGES, "85540", "Bancolombia: Compraste $25.000 en EXITO con tu T.Deb *1234")).toEqual({
      ok: true,
    });
  });

  it("ignores notifications that are not SMS", () => {
    expect(checkSms("com.nexowallet", "Nexo", "anything, código 123456")).toEqual({ ok: true });
  });

  it.each([
    ["Claro", "Tu factura de $89.900 vence mañana"],
    ["85137", "Directv go $25.000 100canales, GamePass ultimate 1 Meses en $35.000"],
    ["Patricio D Colombia", "Bancolombia: Compraste $25.000 en EXITO con tu T.Deb *1234"],
    ["", "Bancolombia: Compraste $25.000 en EXITO"],
  ])("rejects sender %j", (sender, text) => {
    expect(checkSms(MESSAGES, sender, text)).toEqual({ ok: false, reason: "sms_sender_not_allowed" });
  });

  it.each([
    ["87873", "Coomeva Medicina Prepagada informa: su clave activa para aprobar su transaccion es 48213, esta tendra una duracion de (5) minutos"],
    ["50150", "BBVA: El titular de la tarjeta terminada en 9253, debe verificar la compra a AVIANCA por USD 355,50 ingresando el codigo: 482913"],
    ["444", "Tigo te permite navegar y descargar contenidos en tu teléfono acepta las configuraciones, son GRATUITAS Use PIN code 1234 "],
  ])("rejects a one-time code even from an allowed sender (%s)", (sender, text) => {
    expect(checkSms(MESSAGES, sender, text)).toEqual({ ok: false, reason: "sms_one_time_code" });
  });

  it("does not mistake a promo code word for a one-time code", () => {
    const senders = allowedSenders("TIGOPROMO");
    expect(checkSms(MESSAGES, "TIGOPROMO", "Obten 20% OFF hasta 30Jun/26. Usa codigo TIGOON. Compra en b.tigo.com/on1", senders)).toEqual({
      ok: true,
    });
  });

  it("accepts extra senders from the environment", () => {
    const senders = allowedSenders(" 87400 , +57 891333");
    expect(checkSms(MESSAGES, "87400", "Bancolombia: Pagaste $10.000", senders).ok).toBe(true);
    expect(checkSms(MESSAGES, "57891333", "Bancolombia: Pagaste $10.000", senders).ok).toBe(true);
  });
});

describe("normalizeSender", () => {
  it("drops formatting so the same number always compares equal", () => {
    expect(normalizeSender("+57 855-40")).toBe("5785540");
    expect(normalizeSender("Bancolombia")).toBe("bancolombia");
  });
});
