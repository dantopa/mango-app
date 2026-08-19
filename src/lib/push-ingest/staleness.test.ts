import { describe, it, expect, vi, beforeEach } from "vitest";

const sendPushNotification = vi.fn(async () => ({ sent: 1, failed: 0 }));

let subscriptions: Array<{ user_id: string }> = [];
let latestByUser: Record<string, string | null> = {};
let lastUserFilter: string | null = null;

vi.mock("./web-push", () => ({ sendPushNotification: (...args: unknown[]) => sendPushNotification(...args as []) }));

vi.mock("./supabase-admin", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "push_subscriptions") {
        return { select: () => Promise.resolve({ data: subscriptions, error: null }) };
      }
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => {
          lastUserFilter = value;
          return query;
        },
        order: () => query,
        limit: () => query,
        maybeSingle: () =>
          Promise.resolve({
            data: lastUserFilter && latestByUser[lastUserFilter]
              ? { received_at: latestByUser[lastUserFilter] }
              : null,
            error: null,
          }),
      };
      return query;
    },
  }),
}));

import { alertStaleIngest, evaluateStaleness } from "./staleness";

const NOW = new Date("2026-08-18T12:00:00.000Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("evaluateStaleness", () => {
  it("is not stale within the window", () => {
    expect(evaluateStaleness(hoursAgo(10), NOW)).toEqual({ stale: false, hoursSince: 10 });
  });

  it("is stale past 48 hours", () => {
    expect(evaluateStaleness(hoursAgo(49), NOW)).toEqual({ stale: true, hoursSince: 49 });
  });

  it("does not alert a user who never received a notification", () => {
    // No baseline means the reader was never connected, not that it broke.
    expect(evaluateStaleness(null, NOW)).toEqual({ stale: false, hoursSince: null });
  });
});

describe("alertStaleIngest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptions = [{ user_id: "user-1" }];
    latestByUser = {};
    lastUserFilter = null;
  });

  it("pushes an alert when the reader went quiet", async () => {
    // The exact failure that went unnoticed for two months: the forwarder app was
    // uninstalled and the ingest stopped without anything reporting it.
    latestByUser = { "user-1": hoursAgo(24 * 60) };

    const [report] = await alertStaleIngest(NOW);

    expect(report).toMatchObject({ user_id: "user-1", stale: true, alerted: true });
    expect(sendPushNotification).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ tag: "ingest-stale", body: expect.stringContaining("60 días") }),
    );
  });

  it("stays silent while notifications keep arriving", async () => {
    latestByUser = { "user-1": hoursAgo(3) };

    const [report] = await alertStaleIngest(NOW);

    expect(report).toMatchObject({ stale: false, alerted: false });
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("checks each subscribed user once", async () => {
    subscriptions = [{ user_id: "user-1" }, { user_id: "user-1" }, { user_id: "user-2" }];
    latestByUser = { "user-1": hoursAgo(1), "user-2": hoursAgo(72) };

    const reports = await alertStaleIngest(NOW);

    expect(reports.map((r) => r.user_id)).toEqual(["user-1", "user-2"]);
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    expect(sendPushNotification).toHaveBeenCalledWith("user-2", expect.anything());
  });
});
