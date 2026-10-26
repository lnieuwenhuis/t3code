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
  it("round-trips hidden providers and reads older saves without them", () => {
    saveUsagePagePreferences({ metric: "cost", windowDays: 7, hiddenProviders: ["codex"] });
    expect(readUsagePagePreferences().hiddenProviders).toEqual(["codex"]);

    values.set(key, '{"metric":"tokens","windowDays":30}');
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 30 });
  });

  // regression: #10189 an invalid saved usage selection was never replaced
  it.each([
    "not-json",
    '{"metric":"unknown","windowDays":7}',
    '{"metric":"cost","windowDays":365}',
  ])("replaces invalid preferences on the next save: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual({ metric: "limits", windowDays: 30 });
    saveUsagePagePreferences({ metric: "tokens", windowDays: 7 });
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 7 });
  });

  it("contains write failures and can save again after storage recovers", () => {
    saveUsagePagePreferences({ metric: "cost", windowDays: 30 });
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveUsagePagePreferences({ metric: "tokens", windowDays: 7 })).not.toThrow();
    expect(readUsagePagePreferences()).toEqual({ metric: "cost", windowDays: 30 });
    write.mockRestore();
    saveUsagePagePreferences({ metric: "limits", windowDays: 7 });
    expect(readUsagePagePreferences()).toEqual({ metric: "limits", windowDays: 7 });
  });

  it("tells subscribers about every save until they unsubscribe", () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeUsagePagePreferences((preferences) => seen.push(preferences));
    saveUsagePagePreferences({ metric: "limits", windowDays: 7 });
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    saveUsagePagePreferences({ metric: "tokens", windowDays: 1 });
    unsubscribe();
    saveUsagePagePreferences({ metric: "cost", windowDays: 30 });
    expect(seen).toEqual([
      { metric: "limits", windowDays: 7 },
      { metric: "tokens", windowDays: 1 },
    ]);
  });

  it("contains failures when the browser blocks storage access", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError");
      },
    });
    expect(readUsagePagePreferences()).toEqual({ metric: "limits", windowDays: 30 });
    expect(() => saveUsagePagePreferences({ metric: "tokens", windowDays: 7 })).not.toThrow();
  });
});
