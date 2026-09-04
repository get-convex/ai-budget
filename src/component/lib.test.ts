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
const setUserLimits = (t: any, userId: string, limits: any) =>
  t.mutation(api.lib.setBucketLimits, {
    dimension: "user",
    value: userId,
    ...limits,
  });
const bucketOf = async (t: any, dimension: string, value: string) =>
  (await t.query(api.lib.listBuckets, { dimension })).find(
    (b: any) => b.value === value
  );
const userOf = (t: any, userId: string) => bucketOf(t, "user", userId);

describe("reserve / settle spend caps", () => {
  test("a daily cap below one request's reservation blocks up front", async () => {
    const t = convexTest(schema, modules);
    // one gpt-4o-mini request reserves ~480_000 nanodollars ($0.00048); a
    // 1_000-nano ($0.000001) cap can't fit it.
    await setUserLimits(t, "u", { dailySpendLimitNanos: 1_000 });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("user_daily_spend_limit");
  });

  test("reservation is released and settled to the real cost", async () => {
    const t = convexTest(schema, modules);
    await setUserLimits(t, "u", { dailySpendLimitNanos: 1_000_000_000 }); // $1/day
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(true);
    await settle(t, r.requestId, 1_000_000, 1_000_000); // 1M in, 1M out
    const u = await userOf(t, "u");
    // gpt-4o-mini: $0.15/Mtok in + $0.60/Mtok out = $0.75 = 750_000_000 nano.
    expect(u.totalSpendNanos).toBe(750_000_000);
    expect(u.reservedTotalNanos ?? 0).toBe(0);
    expect(u.pendingCount ?? 0).toBe(0);
    expect(u.totalRequests).toBe(1);
  });
});

async function settleWith(t: any, requestId: any, fields: any) {
  await t.mutation(api.lib.finishRequest, { requestId, ...fields });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
}

describe("monthly budgets", () => {
  test("a tiny monthly cap blocks up front", async () => {
    const t = convexTest(schema, modules);
    await setUserLimits(t, "u", { monthlySpendLimitNanos: 1_000 });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("user_monthly_spend_limit");
  });
});

describe("cache-aware pricing", () => {
  test("cached prompt tokens are billed at the discount, not full input", async () => {
    const t = convexTest(schema, modules);
    const r = await start(t, { userId: "u" });
    // 1M prompt, ALL cached, 0 completion. gpt-4o-mini input $0.15/Mtok; the
    // cache default is 10% of input → 0.1 * 150_000_000 = 15_000_000 nano.
    await settleWith(t, r.requestId, {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedTokens: 1_000_000,
    });
    const req = (await t.query(api.lib.getRequest, { requestId: r.requestId }))!;
    expect(req.costNanos).toBe(15_000_000);
    expect(req.cachedTokens).toBe(1_000_000);
  });

  test("an authoritative gateway cost overrides the token estimate", async () => {
    const t = convexTest(schema, modules);
    const r = await start(t, { userId: "u" });
    await settleWith(t, r.requestId, {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      costNanos: 12_345,
    });
    const req = (await t.query(api.lib.getRequest, { requestId: r.requestId }))!;
    expect(req.costNanos).toBe(12_345);
  });
});

describe("durable usage history", () => {
  test("settled spend lands in a per-day usage row", async () => {
    const t = convexTest(schema, modules);
    const r = await start(t, { userId: "u" });
    await settleWith(t, r.requestId, { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    const hist = await t.query(api.lib.usageHistory, {
      dimension: "user",
      value: "u",
      period: "day",
    });
    expect(hist.length).toBe(1);
    expect(hist[0].spendNanos).toBe(750_000_000); // $0.75
    expect(hist[0].requests).toBe(1);
  });
});

describe("manual adjustments", () => {
  test("a credit reduces spend and is logged", async () => {
    const t = convexTest(schema, modules);
    const r = await start(t, { userId: "u" });
    await settleWith(t, r.requestId, { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    await t.mutation(api.lib.adjustBucket, {
      dimension: "user",
      value: "u",
      deltaNanos: -250_000_000,
      reason: "goodwill credit",
    });
    const u = await userOf(t, "u");
    expect(u.totalSpendNanos).toBe(500_000_000); // 750M - 250M
    const log = await t.query(api.lib.listAdjustments, { dimension: "user", value: "u" });
    expect(log.length).toBe(1);
    expect(log[0].deltaNanos).toBe(-250_000_000);
  });
});

describe("threshold alerts", () => {
  test("crossing warnAtPct returns a notice but still admits", async () => {
    const t = convexTest(schema, modules);
    // One "hi" estimate is ~480_150 nano. Cap 800_000, warn at 50% (400_000).
    await setUserLimits(t, "u", { dailySpendLimitNanos: 800_000, warnAtPct: 0.5 });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(true);
    expect(r.notices.length).toBeGreaterThan(0);
  });
});

describe("concurrency cap", () => {
  test("maxConcurrent blocks a second in-flight request", async () => {
    const t = convexTest(schema, modules);
    await setUserLimits(t, "u", { maxConcurrent: 1 });
    const first = await start(t, { userId: "u" });
    expect(first.allowed).toBe(true); // reserved, still pending
    const second = await start(t, { userId: "u" });
    expect(second.allowed).toBe(false);
    expect(second.code).toBe("user_max_concurrent");
  });
});

describe("tag-filtered request log", () => {
  test("listRequests filters by a custom tag dimension", async () => {
    const t = convexTest(schema, modules);
    await start(t, { userId: "u", tags: [{ dimension: "customer", value: "acme" }] });
    await start(t, { userId: "u", tags: [{ dimension: "customer", value: "globex" }] });
    const acme = await t.query(api.lib.listRequests, {
      dimension: "customer",
      value: "acme",
    });
    expect(acme.length).toBe(1);
    expect(acme[0].userId).toBe("u");
  });
});

describe("tagged attribution buckets", () => {
  test("a cap on a custom tag blocks, and settlement accrues to every bucket", async () => {
    const t = convexTest(schema, modules);
    // A tiny cap on customer "acme" — the user is uncapped.
    await t.mutation(api.lib.setBucketLimits, {
      dimension: "customer",
      value: "acme",
      dailySpendLimitNanos: 1_000,
    });
    const blocked = await start(t, {
      userId: "u",
      tags: [{ dimension: "customer", value: "acme" }],
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe("customer_daily_spend_limit");

    // A different customer with no cap goes through, and the spend lands on
    // BOTH the user bucket and the customer bucket.
    const ok = await start(t, {
      userId: "u",
      tags: [{ dimension: "customer", value: "globex" }],
    });
    expect(ok.allowed).toBe(true);
    await settle(t, ok.requestId, 1_000_000, 1_000_000); // $0.75
    const user = await userOf(t, "u");
    const cust = await bucketOf(t, "customer", "globex");
    expect(user.totalSpendNanos).toBe(750_000_000);
    expect(cust.totalSpendNanos).toBe(750_000_000);
    expect(cust.totalRequests).toBe(1);
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
    expect(after.totalSpendNanos).toBeCloseTo(before.totalSpendNanos, 9);
    expect(after.reservedTotalNanos ?? 0).toBeCloseTo(0, 9);
  });
});

describe("token quotas", () => {
  test("a tiny daily token cap blocks (estimate exceeds it)", async () => {
    const t = convexTest(schema, modules);
    await setUserLimits(t, "u", { dailyTokenLimit: 10 });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("user_daily_token_limit");
  });
});

describe("soft enforcement", () => {
  test("over a soft budget: allowed, warned, flagged overBudget", async () => {
    const t = convexTest(schema, modules);
    await setUserLimits(t, "u", {
      dailySpendLimitNanos: 1, // 1 nanodollar — one estimate blows past it
      enforcement: "soft",
    });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    const req = (await t.query(api.lib.getRequest, { requestId: r.requestId }))!;
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
        inputNanosPerMTok: -1,
        outputNanosPerMTok: 5,
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
    // conservative = max over table = {$3 in, $15 out}/Mtok => $18 = 18e9 nano.
    expect(u.totalSpendNanos).toBe(18_000_000_000);
    const req = (await t.query(api.lib.getRequest, { requestId: r.requestId }))!;
    expect(req.unpricedModel).toBe(true);
  });
});
