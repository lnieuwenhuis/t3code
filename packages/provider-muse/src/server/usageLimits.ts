import type { ProviderUsageLimitsUpdate } from "@t3tools/contracts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";

import { LATEST_DATE_MS, type MuseSubscriptionUsage } from "./protocol.ts";

const WEEK_MINS = 7 * 24 * 60;

const isoFromMillis = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/**
 * Muse's rolling window (5 hours today) and weekly block as limit windows.
 * Percentages are verbatim from Meta and may exceed 100; the shared merge clamps them.
 */
export function museUsageToUpdate(
  usage: MuseSubscriptionUsage,
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

/**
 * Muse surfaces Meta's quota refusal as `API error 429: Subscription quota
 * exhausted. Your usage window resets at 2026-10-13T10:45:52Z.`, at times
 * wrapped by a credential proxy. Muse can also type the stop as `error.quota`,
 * but a relayed refusal arrives untyped, so the text still counts.
 */
export function isMuseUsageLimitFailure(message: string | undefined): boolean {
  return message !== undefined && /\b429\b/.test(message) && /quota|usage limit/i.test(message);
}

const NAMED_RESET =
  /\bresets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;

/** Resume only after all exhausted windows reset; use the latest future reset from quota, refusal, or usage. */
export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal?: {
    readonly quota?: { readonly resetsAtMs: number } | undefined;
    readonly message?: string | undefined;
  },
): string | null {
  const named = refusal?.message?.match(NAMED_RESET)?.[1];
  const resets = [
    ...[usage?.window, usage?.weekly].map((window) =>
      window && window.usedPercent >= 100 ? window.resetsAtMs : undefined,
    ),
    refusal?.quota?.resetsAtMs,
    named === undefined ? undefined : Date.parse(named),
  ].filter(
    (ms): ms is number =>
      ms !== undefined && Number.isFinite(ms) && ms > nowMs && ms <= LATEST_DATE_MS,
  );
  return resets.length > 0 ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(...resets))) : null;
}
