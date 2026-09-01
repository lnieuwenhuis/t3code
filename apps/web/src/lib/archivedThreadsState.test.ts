import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { settleWithin } from "./archivedThreadsState";

describe("settleWithin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the value when the promise settles in time", async () => {
    const result = settleWithin(Promise.resolve("value"), 1_000, null);
    await expect(result).resolves.toBe("value");
  });

  it("falls back when the promise never settles", async () => {
    const result = settleWithin(new Promise<string>(() => {}), 1_000, null);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBeNull();
  });

  it("falls back when the promise rejects", async () => {
    const result = settleWithin(Promise.reject(new Error("offline")), 1_000, null);
    await expect(result).resolves.toBeNull();
  });
});
