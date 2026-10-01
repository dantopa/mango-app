import { describe, expect, it } from "vitest";

import { formatBuildTime, isNewerBuild, LAST_SEEN_BUILD_KEY, shortBuild, takeUpdatedFrom } from "../app-version";

const A = "103dc62bdd643f38721f1e5e53545c4ee2d3071a";
const B = "6d83222e2a21f64f27a29b918044e997356e7252";

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

describe("shortBuild", () => {
  it("shortens a commit sha like GitHub does", () => {
    expect(shortBuild(B)).toBe("6d83222");
  });
  it("leaves anything else alone", () => {
    expect(shortBuild("dev")).toBe("dev");
  });
});

describe("isNewerBuild", () => {
  it("is true when the server runs a different build", () => {
    expect(isNewerBuild(A, B)).toBe(true);
  });
  it("is false for the same build, an unknown one, or a local build", () => {
    expect(isNewerBuild(B, B)).toBe(false);
    expect(isNewerBuild(B, null)).toBe(false);
    expect(isNewerBuild("dev", B)).toBe(false);
    expect(isNewerBuild(B, "dev")).toBe(false);
  });
});

describe("takeUpdatedFrom", () => {
  it("says nothing on the first run, and remembers the build", () => {
    const storage = memory();
    expect(takeUpdatedFrom(storage, A)).toBeNull();
    expect(storage.map.get(LAST_SEEN_BUILD_KEY)).toBe(A);
  });

  it("reports the previous build once after an update", () => {
    const storage = memory({ [LAST_SEEN_BUILD_KEY]: A });
    expect(takeUpdatedFrom(storage, B)).toBe(A);
    // Next load on the same build: nothing to announce.
    expect(takeUpdatedFrom(storage, B)).toBeNull();
  });

  it("never announces a local build or survives a broken storage", () => {
    expect(takeUpdatedFrom(memory({ [LAST_SEEN_BUILD_KEY]: A }), "dev")).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
    };
    expect(takeUpdatedFrom(throwing, B)).toBeNull();
    expect(takeUpdatedFrom(null, B)).toBeNull();
  });
});

describe("formatBuildTime", () => {
  it("shows the build time in Bogotá", () => {
    // 01:18 UTC is 20:18 the day before in Bogotá.
    expect(formatBuildTime("2026-10-01T01:18:00Z")).toMatch(/30.*sept?.*2026.*20:18/);
  });
  it("returns null for a missing or invalid time", () => {
    expect(formatBuildTime(null)).toBeNull();
    expect(formatBuildTime("not a date")).toBeNull();
  });
});
