import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// convex-test loads the component's own modules; exclude convex.config (not a
// function module) and the test files themselves.
const modules = import.meta.glob([
  "./**/*.ts",
  "!./**/*.test.ts",
  "!./**/convex.config.ts",
]);

const MODEL = "openai/gpt-4o-mini";
const msg = (content: string) => [{ role: "user", content }];

async function start(t: any, args: any) {
  return t.mutation(api.lib.startRequest, {
    model: MODEL,
    messages: msg("hi"),
    ...args,
  });
}
async function settle(t: any, requestId: any, p = 10, c = 5) {
  await t.mutation(api.lib.finishRequest, {
    requestId,
    promptTokens: p,
    completionTokens: c,
  });
  // finishRequest schedules the fold via runAfter(0); drain it.
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
}
const userOf = async (t: any, userId: string) =>
  (await t.query(api.lib.listUsers, {})).find((u: any) => u.userId === userId);

describe("reserve / settle spend caps", () => {
  test("a daily cap below one request's reservation blocks up front", async () => {
    const t = convexTest(schema, modules);
    // one gpt-4o-mini request reserves ~0.048¢; a 0.01¢ cap can't fit it.
    await t.mutation(api.lib.setLimits, {
      userId: "u",
      dailySpendLimitCents: 0.01,
    });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("user_daily_spend_limit");
  });

  test("reservation is released and settled to the real cost", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.setLimits, {
      userId: "u",
      dailySpendLimitCents: 100,
    });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(true);
    await settle(t, r.requestId, 1_000_000, 1_000_000); // 1M in, 1M out
    const u = await userOf(t, "u");
    // gpt-4o-mini: 15¢/Mtok in + 60¢/Mtok out = 75¢ for 1M+1M.
    expect(u.totalSpendCents).toBeCloseTo(75, 6);
    expect(u.reservedTotalCents ?? 0).toBeCloseTo(0, 6);
    expect(u.pendingCount ?? 0).toBe(0);
    expect(u.totalRequests).toBe(1);
  });
});

describe("D-00 exactly-once settlement", () => {
  test("a duplicate finishRequest does not double-count", async () => {
    const t = convexTest(schema, modules);
    const r = await start(t, { userId: "u" });
    await settle(t, r.requestId); // first settle
    const before = await userOf(t, "u");
    await settle(t, r.requestId); // late duplicate — must be a no-op
    const after = await userOf(t, "u");
    expect(after.totalRequests).toBe(1);
    expect(after.totalRequests).toBe(before.totalRequests);
    expect(after.totalSpendCents).toBeCloseTo(before.totalSpendCents, 9);
    expect(after.reservedTotalCents ?? 0).toBeCloseTo(0, 9);
  });
});

describe("token quotas", () => {
  test("a tiny daily token cap blocks (estimate exceeds it)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.setLimits, { userId: "u", dailyTokenLimit: 10 });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("user_daily_token_limit");
  });
});

describe("soft enforcement", () => {
  test("over a soft budget: allowed, warned, flagged overBudget", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.setLimits, {
      userId: "u",
      dailySpendLimitCents: 0.0001,
      enforcement: "soft",
    });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    const req = await t.query(api.lib.getRequest, { requestId: r.requestId });
    expect(req.overBudget).toBe(true);
  });
});

describe("model policy", () => {
  test("allowlist blocks an off-list model", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.setModelPolicy, {
      mode: "allowlist",
      models: ["openai/gpt-4o-mini"],
    });
    const blocked = await start(t, { userId: "u", model: "openai/gpt-4o" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe("model_not_allowed");
    const ok = await start(t, { userId: "u", model: "openai/gpt-4o-mini" });
    expect(ok.allowed).toBe(true);
  });
});

describe("D-02 pricing validation", () => {
  test("setPrice rejects negative rates", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.lib.setPrice, {
        model: "x/y",
        inputCentsPerMTok: -1,
        outputCentsPerMTok: 5,
      })
    ).rejects.toThrow(/non-negative/);
  });
});

describe("F-04 fail-closed pricing", () => {
  test("an unknown model is charged the conservative max, not zero", async () => {
    const t = convexTest(schema, modules);
    const r = await start(t, { userId: "u", model: "made/up-model" });
    expect(r.allowed).toBe(true);
    await settle(t, r.requestId, 1_000_000, 1_000_000);
    const u = await userOf(t, "u");
    // conservative price = max over table = {300 in, 1500 out} => 300 + 1500¢
    expect(u.totalSpendCents).toBeCloseTo(1800, 6);
    const req = await t.query(api.lib.getRequest, { requestId: r.requestId });
    expect(req.unpricedModel).toBe(true);
  });
});
