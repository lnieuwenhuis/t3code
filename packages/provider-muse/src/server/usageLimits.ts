import type { ProviderUsageLimitsUpdate } from "@t3tools/contracts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const WEEK_MINS = 7 * 24 * 60;

/** MSP `SubscriptionUsage`: the `usage/read` result's `usage` and the `usage/changed` params. */
export const MuseSubscriptionUsage = Schema.Struct({
  observedAtMs: Schema.Finite,
  window: Schema.Struct({
    usedPercent: Schema.Finite,
    windowDurationMins: Schema.Finite.check(Schema.isGreaterThan(0)),
    resetsAtMs: Schema.Finite,
  }),
  weekly: Schema.Struct({
    usedPercent: Schema.Finite,
    resetsAtMs: Schema.Finite,
  }),
});

const isoFromMillis = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/**
 * Muse's rolling window (5 hours today) and weekly block as limit windows.
 * Percentages are verbatim from Meta and may exceed 100; the shared merge clamps them.
 */
export function museUsageToUpdate(
  usage: typeof MuseSubscriptionUsage.Type,
): ProviderUsageLimitsUpdate & { readonly checkedAt: string } {
  return {
    checkedAt: isoFromMillis(usage.observedAtMs),
    windows: [
      {
        id: "window",
        kind: "session",
        label: "Session",
        usedPercent: usage.window.usedPercent,
        resetsAt: isoFromMillis(usage.window.resetsAtMs),
        windowDurationMins: usage.window.windowDurationMins,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: usage.weekly.usedPercent,
        resetsAt: isoFromMillis(usage.weekly.resetsAtMs),
        windowDurationMins: WEEK_MINS,
      },
    ],
  };
}

/**
 * What a status check publishes. Muse only learns its quota from a model
 * response inside a running host, so a fresh probe host always reads nothing.
 * `probeFailed` keeps the bars a turn already reported; before the first turn
 * the Limits view shows this message instead of a bar.
 */
export const museUsageLimitsBeforeTurn = (checkedAt: string) =>
  makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Muse Code reports its limits during a turn. Send it a message to see them.",
  });
