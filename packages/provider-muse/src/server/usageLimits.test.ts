import { describe, expect, it } from "@effect/vitest";

import type { MuseSubscriptionUsage } from "./protocol.ts";
import {
  applyUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe,
} from "@t3tools/provider-core/server/usageLimits";

import {
  isMuseUsageLimitFailure,
  museUsageLimitResetAt,
  museUsageLimitsBeforeTurn,
  museUsageToUpdate,
} from "./usageLimits.ts";

const usageReport = (sessionPercent: number) => ({
  tier: "tier-1",
  window: { usedPercent: sessionPercent, windowDurationMins: 300, resetsAtMs: 1791853028000 },
  weekly: { usedPercent: 1, resetsAtMs: 1792368000000 },
  observedAtMs: 1791835116997,
});

describe("Muse usage limits", () => {
  it("keeps the bars a turn reported through later status checks", () => {
    const beforeTurn = museUsageLimitsBeforeTurn("2026-10-12T19:55:00.000Z");
    const update = museUsageToUpdate(usageReport(4));
    const published = applyUsageLimitsUpdate({
      previous: beforeTurn,
      update,
      checkedAt: update.checkedAt,
    });
    expect(published?.unavailable).toBeUndefined();
    expect(published?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["window", 4],
      ["weekly", 1],
    ]);

    const afterProbe = resolveUsageLimitsAfterProbe({
      published,
      probed: museUsageLimitsBeforeTurn("2026-10-12T20:00:00.000Z"),
    });
    expect(afterProbe).toBe(published);
  });

  it("clamps an over-quota window Meta reports above 100", () => {
    const update = museUsageToUpdate(usageReport(130));
    const limits = applyUsageLimitsUpdate({
      previous: undefined,
      update,
      checkedAt: update.checkedAt,
    });
    expect(limits?.windows.find((window) => window.id === "window")?.usedPercent).toBe(100);
  });
});

// What Meta reported after a reply on 2026-10-08, as Muse forwards it.
const usage = {
  observedAtMs: 1791447762610,
  tier: "tier-1",
  window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: 1791465557000 },
  weekly: { usedPercent: 5, resetsAtMs: 1791763200000 },
} satisfies MuseSubscriptionUsage;
const nowMs = usage.observedAtMs;
// How Muse 1.4.6 ended a turn at a real quota stop (2026-10-13), relayed by a credential proxy.
const realRefusal =
  "API error 429: All credentials for model muse-wonder-1.0-contributor are cooling down (last error: rate_limit_exceeded: Subscription quota exhausted. Your usage window resets at 2026-10-13T10:45:52Z.) (after 10 provider attempts)";

describe("Muse usage limit failures", () => {
  it("recognizes Meta's quota refusal and no other failure", () => {
    expect(
      isMuseUsageLimitFailure(
        "API error 429: Subscription quota exhausted. Your usage window resets soon. (rate_limit_error)",
      ),
    ).toBe(true);
    expect(isMuseUsageLimitFailure(realRefusal)).toBe(true);
    // A plain rate limit retries on its own; it is not a used-up subscription window.
    expect(isMuseUsageLimitFailure("API error 429: Rate limit exceeded. (rate_limit_error)")).toBe(
      false,
    );
    expect(isMuseUsageLimitFailure("Subscription quota exhausted.")).toBe(false);
    expect(isMuseUsageLimitFailure(undefined)).toBe(false);
  });

  it("resumes once every exhausted window has reset", () => {
    const sessionOut = { ...usage, window: { ...usage.window, usedPercent: 103 } };
    expect(museUsageLimitResetAt(sessionOut, nowMs)).toBe("2026-10-08T13:19:17.000Z");
    const bothOut = { ...sessionOut, weekly: { ...usage.weekly, usedPercent: 100 } };
    expect(museUsageLimitResetAt(bothOut, nowMs)).toBe("2026-10-12T00:00:00.000Z");
  });

  it("takes the reset a refusal names or types when no report has one", () => {
    expect(museUsageLimitResetAt(undefined, nowMs, { message: realRefusal })).toBe(
      "2026-10-13T10:45:52.000Z",
    );
    const quota = { resetsAtMs: usage.window.resetsAtMs };
    expect(museUsageLimitResetAt(usage, nowMs, { quota })).toBe("2026-10-08T13:19:17.000Z");
    // A used-up weekly window still holds the turn back after the typed reset.
    const weeklyOut = { ...usage, weekly: { ...usage.weekly, usedPercent: 100 } };
    expect(museUsageLimitResetAt(weeklyOut, nowMs, { quota })).toBe("2026-10-12T00:00:00.000Z");
  });

  it("has no reset time unless a report shows a used-up window that resets later", () => {
    expect(museUsageLimitResetAt(undefined, nowMs)).toBeNull();
    expect(museUsageLimitResetAt(usage, nowMs)).toBeNull();
    const sessionOut = { ...usage, window: { ...usage.window, usedPercent: 100 } };
    expect(museUsageLimitResetAt(sessionOut, usage.window.resetsAtMs)).toBeNull();
    const afterNamedReset = Date.parse("2026-10-14T00:00:00Z");
    expect(museUsageLimitResetAt(undefined, afterNamedReset, { message: realRefusal })).toBeNull();
  });
});
