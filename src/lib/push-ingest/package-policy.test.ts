import { describe, expect, it } from "vitest";

import { appDecisionSchema, buildPolicy, isAllowed, NEVER_ALLOWED } from "./package-policy";
import { PACKAGE_WHITELIST } from "./package-whitelist";

describe("buildPolicy", () => {
  it("is the built-in list when the user has decided nothing", () => {
    const policy = buildPolicy([]);
    for (const pkg of PACKAGE_WHITELIST) expect(isAllowed(policy, pkg)).toBe(true);
  });

  it("lets a decision add an app nobody hard-coded", () => {
    const policy = buildPolicy([{ package_name: "com.mercadopago.wallet", decision: "allowed" }]);
    expect(isAllowed(policy, "com.mercadopago.wallet")).toBe(true);
  });

  it("lets a decision block a built-in app", () => {
    const policy = buildPolicy([{ package_name: "com.grability.rappi", decision: "blocked" }]);
    expect(isAllowed(policy, "com.grability.rappi")).toBe(false);
    expect(policy.blocked.has("com.grability.rappi")).toBe(true);
  });

  it("never allows a chat app, whatever the row says", () => {
    const policy = buildPolicy([{ package_name: "com.whatsapp", decision: "allowed" }]);
    expect(isAllowed(policy, "com.whatsapp")).toBe(false);
    expect(policy.blocked.has("com.whatsapp")).toBe(true);
  });

  it("does not let a default sneak a never-allowed app in", () => {
    const policy = buildPolicy([], new Set(["com.whatsapp", "com.brubank"]));
    expect(isAllowed(policy, "com.whatsapp")).toBe(false);
    expect(isAllowed(policy, "com.brubank")).toBe(true);
  });

  it("ignores rows with an unknown decision", () => {
    const policy = buildPolicy([{ package_name: "com.example.bank", decision: "maybe" }]);
    expect(isAllowed(policy, "com.example.bank")).toBe(false);
    expect(policy.blocked.has("com.example.bank")).toBe(false);
  });
});

describe("appDecisionSchema", () => {
  it("accepts an Android package name", () => {
    expect(appDecisionSchema.safeParse({ packageName: "com.brubank", label: "Brubank", decision: "allowed" }).success).toBe(true);
  });

  it.each(["brubank", "com..brubank", "1com.bank", "com.bank/../x", "com.bank;drop"])(
    "rejects %s",
    (packageName) => {
      expect(appDecisionSchema.safeParse({ packageName, decision: "allowed" }).success).toBe(false);
    },
  );

  it("caps the label", () => {
    expect(appDecisionSchema.safeParse({ packageName: "com.a.b", label: "x".repeat(81), decision: "allowed" }).success).toBe(false);
  });

  it("keeps the never-allowed list free of anything the defaults need", () => {
    for (const pkg of PACKAGE_WHITELIST) expect(NEVER_ALLOWED.has(pkg)).toBe(false);
  });
});
