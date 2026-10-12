import { describe, expect, it } from "vite-plus/test";
import {
  applyUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe,
} from "@t3tools/provider-core/server/usageLimits";

import { museUsageLimitsBeforeTurn, museUsageToUpdate } from "./usageLimits.ts";

const usage = (sessionPercent: number) => ({
  window: { usedPercent: sessionPercent, windowDurationMins: 300, resetsAtMs: 1791853028000 },
  weekly: { usedPercent: 1, resetsAtMs: 1792368000000 },
  observedAtMs: 1791835116997,
});

describe("Muse usage limits", () => {
  it("keeps the bars a turn reported through later status checks", () => {
    const beforeTurn = museUsageLimitsBeforeTurn("2026-10-12T19:55:00.000Z");
    const update = museUsageToUpdate(usage(4));
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
    const update = museUsageToUpdate(usage(130));
    const limits = applyUsageLimitsUpdate({
      previous: undefined,
      update,
      checkedAt: update.checkedAt,
    });
    expect(limits?.windows.find((window) => window.id === "window")?.usedPercent).toBe(100);
  });
});
