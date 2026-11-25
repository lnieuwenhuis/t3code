import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  subscribeUsagePagePreferences,
} from "./usagePagePreferences";

const key = "t3code:usage-page-preferences:v1";
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;

beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Usage page preferences", () => {
  it("round-trips hidden providers and new windows, and reads legacy windowDays saves", () => {
    saveUsagePagePreferences({ metric: "cost", window: "5h", hiddenProviders: ["codex"] });
    expect(readUsagePagePreferences()).toEqual({
      metric: "cost",
      window: "5h",
      hiddenProviders: ["codex"],
    });

    saveUsagePagePreferences({ metric: "tokens", window: "180d" });
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", window: "180d" });

    values.set(key, '{"metric":"tokens","windowDays":30}');
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", window: "30d" });

    values.set(key, '{"metric":"cost","windowDays":1,"hiddenProviders":["claude"]}');
    expect(readUsagePagePreferences()).toEqual({
      metric: "cost",
      window: "24h",
      hiddenProviders: ["claude"],
    });
  });

  // regression: #10189 an invalid saved usage selection was never replaced
  it.each([
    "not-json",
    '{"metric":"unknown","window":"7d"}',
    '{"metric":"cost","window":"365d"}',
    '{"metric":"cost","windowDays":365}',
  ])("replaces invalid preferences on the next save: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual({ metric: "limits", window: "30d" });
    saveUsagePagePreferences({ metric: "tokens", window: "12h" });
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", window: "12h" });
  });

  it("contains write failures and can save again after storage recovers", () => {
    saveUsagePagePreferences({ metric: "cost", window: "30d" });
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveUsagePagePreferences({ metric: "tokens", window: "7d" })).not.toThrow();
    expect(readUsagePagePreferences()).toEqual({ metric: "cost", window: "30d" });
    write.mockRestore();
    saveUsagePagePreferences({ metric: "limits", window: "7d" });
    expect(readUsagePagePreferences()).toEqual({ metric: "limits", window: "7d" });
  });

  it("tells subscribers about every save until they unsubscribe", () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeUsagePagePreferences((preferences) => seen.push(preferences));
    saveUsagePagePreferences({ metric: "limits", window: "7d" });
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    saveUsagePagePreferences({ metric: "tokens", window: "24h" });
    unsubscribe();
    saveUsagePagePreferences({ metric: "cost", window: "30d" });
    expect(seen).toEqual([
      { metric: "limits", window: "7d" },
      { metric: "tokens", window: "24h" },
    ]);
  });

  it("contains failures when the browser blocks storage access", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError");
      },
    });
    expect(readUsagePagePreferences()).toEqual({ metric: "limits", window: "30d" });
    expect(() => saveUsagePagePreferences({ metric: "tokens", window: "7d" })).not.toThrow();
  });
});
