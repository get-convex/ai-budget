import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import shardedCounterTest from "@convex-dev/sharded-counter/test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

// convex-test loads the component's own modules; exclude convex.config (not a
// function module) and the test files themselves.
const modules = import.meta.glob([
  "./**/*.ts",
  "!./**/*.test.ts",
  "!./**/convex.config.ts",
]);

function initTest() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  shardedCounterTest.register(t);
  return t;
}

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
    const t = initTest();
    // one gpt-4o-mini request reserves ~480_000 nanodollars ($0.00048); a
    // 1_000-nano ($0.000001) cap can't fit it.
    await setUserLimits(t, "u", { dailySpendLimitNanos: 1_000 });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("user_daily_spend_limit");
  });

  test("reservation is released and settled to the real cost", async () => {
    const t = initTest();
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
    const t = initTest();
    await setUserLimits(t, "u", { monthlySpendLimitNanos: 1_000 });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("user_monthly_spend_limit");
  });
});

describe("cache-aware pricing", () => {
  test("cached prompt tokens are billed at the discount, not full input", async () => {
    const t = initTest();
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
    const t = initTest();
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

describe("server-tool pricing", () => {
  test("server-tool uses add a per-call fee on top of tokens", async () => {
    const t = initTest();
    const r = await start(t, { userId: "u" });
    // 0 tokens; 3 web searches at the $0.01 default = 30_000_000 nano.
    await settleWith(t, r.requestId, {
      promptTokens: 0,
      completionTokens: 0,
      serverToolUses: { web_search: 3 },
    });
    const req = (await t.query(api.lib.getRequest, { requestId: r.requestId }))!;
    expect(req.costNanos).toBe(30_000_000);
    expect(req.serverToolUses).toEqual({ web_search: 3 });
  });

  test("an override price is applied", async () => {
    const t = initTest();
    await t.mutation(api.lib.setServerToolPrice, {
      tool: "web_search",
      nanosPerCall: 12_000_000,
    });
    const r = await start(t, { userId: "u" });
    await settleWith(t, r.requestId, {
      promptTokens: 0,
      completionTokens: 0,
      serverToolUses: { web_search: 2 },
    });
    const req = (await t.query(api.lib.getRequest, { requestId: r.requestId }))!;
    expect(req.costNanos).toBe(24_000_000);
  });

  test("an authoritative cost already includes tool fees (not double-charged)", async () => {
    const t = initTest();
    const r = await start(t, { userId: "u" });
    await settleWith(t, r.requestId, {
      promptTokens: 1_000_000,
      completionTokens: 0,
      serverToolUses: { web_search: 5 },
      costNanos: 999,
    });
    const req = (await t.query(api.lib.getRequest, { requestId: r.requestId }))!;
    expect(req.costNanos).toBe(999);
  });
});

describe("cost known up front (image gen, per-call APIs)", () => {
  test("estimatedCostNanos drives the reservation for a hard cap", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { dailySpendLimitNanos: 100_000_000 }); // $0.10
    // A $0.13 image is known before the call; reserving it exceeds the cap,
    // even though the token estimate for the prompt alone would pass.
    const r = await start(t, {
      userId: "u",
      model: "openai/gpt-image-1",
      estimatedCostNanos: 130_000_000,
    });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("user_daily_spend_limit");
  });

  test("admits when it fits, then settles to the real per-image cost", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { dailySpendLimitNanos: 500_000_000 });
    const r = await start(t, {
      userId: "u",
      model: "openai/gpt-image-1",
      estimatedCostNanos: 130_000_000,
    });
    expect(r.allowed).toBe(true);
    await settleWith(t, r.requestId, { costNanos: 130_000_000 });
    const u = await userOf(t, "u");
    expect(u.totalSpendNanos).toBe(130_000_000);
    expect(u.reservedTotalNanos ?? 0).toBe(0);
  });
});

describe("async lifecycle (video jobs): begin now, settle later", () => {
  test("reserveTtlMs is stored, and settle records the real cost", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { dailySpendLimitNanos: 5_000_000_000 });
    // Reserve $2 for a long job that will settle minutes later.
    const r = await start(t, {
      userId: "u",
      model: "openai/sora",
      estimatedCostNanos: 2_000_000_000,
      reserveTtlMs: 30 * 60 * 1000,
    });
    expect(r.allowed).toBe(true);
    const pending = (await t.query(api.lib.getRequest, { requestId: r.requestId }))!;
    expect(pending.status).toBe("pending");
    expect(pending.reserveTtlMs).toBe(30 * 60 * 1000);
    // held reservation
    let u = await userOf(t, "u");
    expect(u.reservedTotalNanos).toBe(2_000_000_000);

    // …later: the webhook fires and settles the actual cost.
    await settleWith(t, r.requestId, { costNanos: 1_800_000_000 });
    u = await userOf(t, "u");
    expect(u.totalSpendNanos).toBe(1_800_000_000);
    expect(u.reservedTotalNanos ?? 0).toBe(0);
  });
});

describe("durable usage history", () => {
  test("settled spend lands in a per-day usage row", async () => {
    const t = initTest();
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
  test("a credit accrues separately from gross spend and grants headroom", async () => {
    const t = initTest();
    const r = await start(t, { userId: "u" });
    await settleWith(t, r.requestId, { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    await t.mutation(api.lib.adjustBucket, {
      dimension: "user",
      value: "u",
      deltaNanos: -250_000_000,
      reason: "goodwill credit",
    });
    const u = await userOf(t, "u");
    // Gross spend is unchanged (credits never reduce it); the credit is tracked
    // separately. Net = gross - credits = 500M.
    expect(u.totalSpendNanos).toBe(750_000_000);
    expect(u.creditsNanos).toBe(250_000_000);
    const log = await t.query(api.lib.listAdjustments, { dimension: "user", value: "u" });
    expect(log.length).toBe(1);
    expect(log[0].deltaNanos).toBe(-250_000_000);
  });

  test("a credit grants headroom under a cap; a debit consumes gross spend", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { lifetimeSpendLimitNanos: 1_000_000_000 });
    const r = await start(t, { userId: "u" });
    await settleWith(t, r.requestId, { costNanos: 900_000_000 }); // $0.90 gross
    // Right at the edge: a $0.20 estimate would exceed the $1 cap...
    expect((await start(t, { userId: "u", estimatedCostNanos: 200_000_000 })).allowed).toBe(false);
    // ...but a $0.30 credit (net spend $0.60) reopens headroom.
    await t.mutation(api.lib.adjustBucket, { dimension: "user", value: "u", deltaNanos: -300_000_000 });
    expect((await start(t, { userId: "u", estimatedCostNanos: 200_000_000 })).allowed).toBe(true);
  });
});

describe("threshold alerts", () => {
  test("crossing warnAtPct returns a notice but still admits", async () => {
    const t = initTest();
    // One "hi" estimate is ~480_150 nano. Cap 800_000, warn at 50% (400_000).
    await setUserLimits(t, "u", { dailySpendLimitNanos: 800_000, warnAtPct: 0.5 });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(true);
    expect(r.notices.length).toBeGreaterThan(0);
  });
});

describe("concurrency cap", () => {
  test("maxConcurrent blocks a second in-flight request", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { maxConcurrent: 1 });
    const first = await start(t, { userId: "u" });
    expect(first.allowed).toBe(true); // reserved, still pending
    const second = await start(t, { userId: "u" });
    expect(second.allowed).toBe(false);
    expect(second.code).toBe("user_max_concurrent");
  });
});

describe("per-bucket rate limits", () => {
  test("refills continuously and does not consume other buckets on rejection", async () => {
    vi.useFakeTimers();
    try {
      const t = initTest();
      await setUserLimits(t, "u", { requestsPerMinute: 2 });
      await t.mutation(api.lib.setBucketLimits, {
        dimension: "action", value: "busy", requestsPerMinute: 1,
      });
      expect((await start(t, { userId: "other", actionName: "busy" })).allowed).toBe(true);
      expect((await start(t, { userId: "u", actionName: "busy" })).code).toBe("action_rate_limit");
      expect((await start(t, { userId: "u", actionName: "free" })).allowed).toBe(true);
      expect((await start(t, { userId: "u", actionName: "free" })).allowed).toBe(true);
      expect((await start(t, { userId: "u", actionName: "free" })).allowed).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect((await start(t, { userId: "u", actionName: "free" })).allowed).toBe(true);
      expect((await start(t, { userId: "u", actionName: "free" })).allowed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("changing the rate preserves consumption and clamps to capacity", async () => {
    vi.useFakeTimers();
    try {
      const t = initTest();
      await setUserLimits(t, "u", { requestsPerMinute: 2 });
      expect((await start(t, { userId: "u" })).allowed).toBe(true);
      expect((await start(t, { userId: "u" })).allowed).toBe(true);
      await setUserLimits(t, "u", { requestsPerMinute: 4 });
      expect((await start(t, { userId: "u" })).allowed).toBe(false);
      vi.advanceTimersByTime(15_000);
      expect((await start(t, { userId: "u" })).allowed).toBe(true);
      vi.advanceTimersByTime(60_000);
      await setUserLimits(t, "u", { requestsPerMinute: 1 });
      expect((await start(t, { userId: "u" })).allowed).toBe(true);
      expect((await start(t, { userId: "u" })).allowed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("zero blocks and invalid rates are rejected", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { requestsPerMinute: 0 });
    expect((await start(t, { userId: "u" })).code).toBe("rate_limit");
    for (const requestsPerMinute of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      await expect(setUserLimits(t, "u", { requestsPerMinute })).rejects.toThrow(/requestsPerMinute/);
    }
  });

  test("deleting and recreating a bucket starts a fresh rate balance", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { requestsPerMinute: 1 });
    expect((await start(t, { userId: "u" })).allowed).toBe(true);
    await t.mutation(api.lib.deleteBucket, { dimension: "user", value: "u" });
    await setUserLimits(t, "u", { requestsPerMinute: 1 });
    expect((await start(t, { userId: "u" })).allowed).toBe(true);
  });

  test("the existing user rate limit remains compatible", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { requestsPerMinute: 1 });
    const first = await start(t, { userId: "u" });
    expect(first.allowed).toBe(true);
    const second = await start(t, { userId: "u" });
    expect(second.allowed).toBe(false);
    expect(second.code).toBe("rate_limit");
  });

  test("an action rate limit blocks the next request for that action", async () => {
    const t = initTest();
    await t.mutation(api.lib.setBucketLimits, {
      dimension: "action",
      value: "ai:summarize",
      requestsPerMinute: 1,
    });
    const first = await start(t, { userId: "u1", actionName: "ai:summarize" });
    expect(first.allowed).toBe(true);
    const second = await start(t, { userId: "u2", actionName: "ai:summarize" });
    expect(second.allowed).toBe(false);
    expect(second.code).toBe("action_rate_limit");
  });

  test("a custom-tag rate limit blocks the next request for that value", async () => {
    const t = initTest();
    await t.mutation(api.lib.setBucketLimits, {
      dimension: "customer",
      value: "acme",
      requestsPerMinute: 1,
    });
    const tags = [{ dimension: "customer", value: "acme" }];
    const first = await start(t, { userId: "u1", tags });
    expect(first.allowed).toBe(true);
    const second = await start(t, { userId: "u2", tags });
    expect(second.allowed).toBe(false);
    expect(second.code).toBe("customer_rate_limit");
  });
});

describe("tag-filtered request log", () => {
  test("listRequests filters by a custom tag dimension", async () => {
    const t = initTest();
    await start(t, { userId: "u", tags: [{ dimension: "customer", value: "acme" }] });
    await start(t, { userId: "u", tags: [{ dimension: "customer", value: "globex" }] });
    const acme = await t.query(api.lib.listRequests, {
      dimension: "customer",
      value: "acme",
    });
    expect(acme.length).toBe(1);
    expect(acme[0].userId).toBe("u");
  });

  test("blocked attempts appear in the tag-filtered log", async () => {
    const t = initTest();
    const tags = [{ dimension: "burst", value: "run-1" }];
    // Cap the tag bucket below one request's reservation so the attempt is
    // budget-blocked (a persisted rejection).
    await t.mutation(api.lib.setBucketLimits, {
      dimension: "burst",
      value: "run-1",
      lifetimeSpendLimitNanos: 1_000,
    });
    const r = await start(t, { userId: "u", tags });
    expect(r.allowed).toBe(false);
    const log = await t.query(api.lib.listRequests, {
      dimension: "burst",
      value: "run-1",
    });
    expect(log.length).toBe(1);
    expect(log[0].status).toBe("blocked");
  });

  test("persisted blocked attempts don't consume a custom-tag rate limit", async () => {
    const t = initTest();
    await t.mutation(api.lib.setBucketLimits, {
      dimension: "customer",
      value: "acme",
      requestsPerMinute: 1,
      // also cap spend so attempts get budget-blocked (persisted) first
      lifetimeSpendLimitNanos: 1_000,
    });
    const tags = [{ dimension: "customer", value: "acme" }];
    // A budget-blocked (persisted) attempt writes a requestTags row…
    const blocked = await start(t, { userId: "u1", tags });
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe("customer_lifetime_spend_limit");
    // …which must NOT count toward the 1/min rate limit. Lift the spend cap:
    // with no admitted requests in the window, the next request goes through.
    await t.mutation(api.lib.setBucketLimits, {
      dimension: "customer",
      value: "acme",
      lifetimeSpendLimitNanos: 1_000_000_000,
    });
    const next = await start(t, { userId: "u2", tags });
    expect(next.allowed).toBe(true);
  });
});

describe("tagged attribution buckets", () => {
  test("a cap on a custom tag blocks, and settlement accrues to every bucket", async () => {
    const t = initTest();
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
    const t = initTest();
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
    const t = initTest();
    await setUserLimits(t, "u", { dailyTokenLimit: 10 });
    const r = await start(t, { userId: "u" });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("user_daily_token_limit");
  });
});

describe("soft enforcement", () => {
  test("over a soft budget: allowed, warned, flagged overBudget", async () => {
    const t = initTest();
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
    const t = initTest();
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
  test("setPrice rejects negative and non-finite rates", async () => {
    const t = initTest();
    for (const inputNanosPerMTok of [-1, NaN, Infinity, 0.5]) {
      await expect(
        t.mutation(api.lib.setPrice, {
          model: "x/y",
          inputNanosPerMTok,
          outputNanosPerMTok: 5,
        })
      ).rejects.toThrow(/inputNanosPerMTok/);
    }
  });
});

describe("F-04 fail-closed pricing", () => {
  test("an unknown model is charged the conservative max, not zero", async () => {
    const t = initTest();
    const r = await start(t, { userId: "u", model: "made/up-model" });
    expect(r.allowed).toBe(true);
    await settle(t, r.requestId, 1_000_000, 1_000_000);
    const u = await userOf(t, "u");
    // Conservative fallback is a frontier ceiling of {$20 in, $100 out}/Mtok, so
    // 1M in + 1M out => $120 = 120e9 nano (over-count is the safe direction).
    expect(u.totalSpendNanos).toBe(120_000_000_000);
    const req = (await t.query(api.lib.getRequest, { requestId: r.requestId }))!;
    expect(req.unpricedModel).toBe(true);
  });
});

describe("accounting lifecycle regressions", () => {
  test("old-day and old-month settlements preserve new holds", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
      const t = initTest();
      await setUserLimits(t, "u", { dailySpendLimitNanos: 1000, monthlySpendLimitNanos: 1000 });
      const old = await start(t, { userId: "u", estimatedCostNanos: 100 });
      vi.setSystemTime(new Date("2026-10-01T00:01:00Z"));
      await start(t, { userId: "u", estimatedCostNanos: 100 });
      await t.mutation(api.lib.finishRequest, { requestId: old.requestId, costNanos: 0 });
      await t.mutation(internal.lib.foldTotals, { requestId: old.requestId });
      const b = await userOf(t, "u");
      expect(b.reservedTodayNanos).toBe(100);
      expect(b.reservedMonthNanos).toBe(100);
      expect(b.reservedTotalNanos).toBe(100);
      expect(b.pendingCount).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  test("a request admitted before caps were enabled cannot release a later hold", async () => {
    const t = initTest();
    const old = await start(t, { userId: "u", estimatedCostNanos: 100 });
    await setUserLimits(t, "u", { dailySpendLimitNanos: 1000 });
    await start(t, { userId: "u", estimatedCostNanos: 100 });
    await t.mutation(api.lib.finishRequest, { requestId: old.requestId, costNanos: 0 });
    await t.mutation(internal.lib.foldTotals, { requestId: old.requestId });
    expect((await userOf(t, "u")).reservedTotalNanos).toBe(100);
  });

  test("expiry releases once, survives retention, and accepts one late charge", async () => {
    vi.useFakeTimers();
    try {
      const t = initTest();
      await setUserLimits(t, "u", { dailySpendLimitNanos: 1000 });
      const job = await start(t, { userId: "u", estimatedCostNanos: 100 });
      vi.advanceTimersByTime(2 * 60 * 60_000);
      await t.mutation(internal.lib.expirePhase, {});
      expect((await userOf(t, "u")).reservedTotalNanos).toBe(0);
      await start(t, { userId: "u", estimatedCostNanos: 100 });
      await t.mutation(api.lib.finishRequest, { requestId: job.requestId, costNanos: 75 });
      await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
      await t.mutation(api.lib.finishRequest, { requestId: job.requestId, costNanos: 999 });
      await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
      const b = await userOf(t, "u");
      expect(b.totalSpendNanos).toBe(75);
      expect(b.totalRequests).toBe(1);
      expect(b.reservedTotalNanos).toBe(100);
      expect((await t.query(api.lib.getGlobalStatus, {})).spentTotalNanos).toBe(75);
    } finally { vi.useRealTimers(); }
  });

  test("long TTL jobs cannot hide expired jobs", async () => {
    vi.useFakeTimers();
    try {
      const t = initTest();
      await t.run(async ctx => {
        for (let i = 0; i < 201; i++) await ctx.db.insert("requests", {
          userId: "long", model: MODEL, messages: [], status: "pending",
          expiresAt: Date.now() + 86400_000, heldBucketIds: [],
        });
      });
      const short = await start(t, { userId: "short" });
      vi.advanceTimersByTime(31 * 60_000);
      const result = await t.mutation(internal.lib.expirePhase, {});
      expect(result.expired).toBe(1);
      expect((await t.run(ctx => ctx.db.get(short.requestId))).reservationExpired).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  test("global accounting includes usage before limits are enabled", async () => {
    const t = initTest();
    const job = await start(t, { userId: "u" });
    await t.mutation(api.lib.finishRequest, { requestId: job.requestId, costNanos: 100 });
    await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
    expect((await t.query(api.lib.getGlobalStatus, {})).spentTotalNanos).toBe(100);
    await t.mutation(api.lib.setGlobalLimits, { lifetimeSpendLimitNanos: 100 });
    // The killswitch trips out-of-band (H4): the reconciler's globalPhase
    // compares the sharded total to the cap and flags settings; admission reads
    // the flag. So a request admits until the flag is set, then blocks.
    expect((await start(t, { userId: "u", estimatedCostNanos: 1 })).allowed).toBe(true);
    await t.mutation(internal.lib.globalPhase, {});
    expect((await start(t, { userId: "u", estimatedCostNanos: 1 })).allowed).toBe(false);
  });

  test("settlement does not write admission policy, but changing limits does", async () => {
    const t = initTest();
    const job = await start(t, { userId: "u" });
    const before = await t.run(ctx => ctx.db.query("bucketPolicies").collect());
    await t.mutation(api.lib.finishRequest, { requestId: job.requestId, costNanos: 100 });
    await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
    expect(await t.run(ctx => ctx.db.query("bucketPolicies").collect())).toEqual(before);
    await setUserLimits(t, "u", { blocked: true });
    expect((await start(t, { userId: "u" })).allowed).toBe(false);
  });
});

test("legacy pending rows acquire deadlines without starving newer expired work", async () => {
  vi.useFakeTimers();
  try {
    const t = initTest();
    await t.run(async ctx => {
      for (let i = 0; i < 201; i++) await ctx.db.insert("requests", {
        userId: "legacy", model: MODEL, messages: [], status: "pending", reserveTtlMs: 86400_000,
      });
    });
    const job = await start(t, { userId: "new" });
    vi.advanceTimersByTime(31 * 60_000);
    expect((await t.mutation(internal.lib.expirePhase, {})).expired).toBe(1);
    expect((await t.run(ctx => ctx.db.get(job.requestId))).reservationExpired).toBe(true);
    // The phase self-reschedules to backfill the remaining legacy rows in
    // batches; drain those scheduled continuations.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run(ctx => ctx.db.query("requests").withIndex("status_expires", q =>
      q.eq("status", "pending").eq("expiresAt", undefined)).take(1))).toHaveLength(0);
  } finally { vi.useRealTimers(); }
});

test("retention progresses past unresolved jobs", async () => {
  vi.useFakeTimers();
  try {
    const t = initTest();
    await t.run(async ctx => {
      for (let i = 0; i < 501; i++) await ctx.db.insert("requests", {
        userId: "long", model: MODEL, messages: [], status: "pending", expiresAt: Date.now() + 86400_000,
      });
    });
    const job = await start(t, { userId: "short" });
    await t.mutation(api.lib.finishRequest, { requestId: job.requestId, costNanos: 0 });
    await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
    vi.advanceTimersByTime(2 * 60 * 60_000);
    expect((await t.mutation(internal.lib.retentionPhase, {})).purged).toBe(1);
    expect(await t.run(ctx => ctx.db.get(job.requestId))).toBeNull();
  } finally { vi.useRealTimers(); }
});

test("delayed folding attributes spend to completion day and leaves newer holds intact", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
    const t = initTest();
    await setUserLimits(t, "u", { dailySpendLimitNanos: 1000 });
    const job = await start(t, { userId: "u", estimatedCostNanos: 100 });
    await t.mutation(api.lib.finishRequest, { requestId: job.requestId, costNanos: 50 });
    vi.setSystemTime(new Date("2026-10-01T00:01:00Z"));
    await start(t, { userId: "u", estimatedCostNanos: 100 });
    await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
    const b = await userOf(t, "u");
    expect(b.spendTodayNanos).toBe(0);
    expect(b.reservedTodayNanos).toBe(100);
    const history = await t.query(api.lib.usageHistory, { dimension: "user", value: "u", period: "day" });
    expect(history[0].stamp).toBe("2026-09-30");
    expect(history[0].spendNanos).toBe(50);
  } finally { vi.useRealTimers(); }
});

describe("v1 hardening", () => {
  test("setGlobalLimits: a one-field update preserves the other global limits", async () => {
    const t = initTest();
    await t.mutation(api.lib.setGlobalLimits, {
      dailySpendLimitNanos: 100,
      lifetimeSpendLimitNanos: 500,
      enforcement: "soft",
    });
    // Update ONLY the daily cap — must not wipe lifetime/enforcement.
    await t.mutation(api.lib.setGlobalLimits, { dailySpendLimitNanos: 200 });
    const g = await t.query(api.lib.getGlobalStatus, {});
    expect(g.dailySpendLimitNanos).toBe(200);
    expect(g.lifetimeSpendLimitNanos).toBe(500);
    expect(g.enforcement).toBe("soft");
    // Explicit null clears just that field.
    await t.mutation(api.lib.setGlobalLimits, { lifetimeSpendLimitNanos: null });
    const after = await t.query(api.lib.getGlobalStatus, {});
    expect(after.lifetimeSpendLimitNanos).toBe(null);
    expect(after.dailySpendLimitNanos).toBe(200);
  });

  test("finishRequest on a missing/deleted request is a graceful no-op", async () => {
    const t = initTest();
    const r = await start(t, { userId: "u" });
    await t.mutation(api.lib.deleteBucket, { dimension: "user", value: "u" });
    // The request row is gone; a late/duplicate webhook must not throw.
    const out = await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      costNanos: 1_000_000,
    });
    expect(out.costNanos).toBe(0);
  });

  test("deleting a user releases holds it placed on a shared bucket", async () => {
    const t = initTest();
    // A shared action bucket with a cap, so requests reserve against it.
    await t.mutation(api.lib.setBucketLimits, {
      dimension: "action",
      value: "shared",
      lifetimeSpendLimitNanos: 1_000_000_000,
    });
    // A pending (unsettled) request from user "u" attributed to that action.
    await start(t, { userId: "u", actionName: "shared" });
    let action = await bucketOf(t, "action", "shared");
    expect(action.reservedTotalNanos).toBeGreaterThan(0);
    expect(action.pendingCount).toBe(1);
    // Deleting the user must free the shared bucket's hold, not strand it.
    await t.mutation(api.lib.deleteBucket, { dimension: "user", value: "u" });
    action = await bucketOf(t, "action", "shared");
    expect(action.reservedTotalNanos ?? 0).toBe(0);
    expect(action.pendingCount ?? 0).toBe(0);
  });

  test("a NaN/Infinity cost or token count cannot poison bucket totals", async () => {
    const t = initTest();
    const r = await start(t, { userId: "u" });
    await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      costNanos: NaN,          // ignored (not finite) -> token pricing
      promptTokens: NaN,       // coerced to 0
      completionTokens: 5,
    });
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const u = await userOf(t, "u");
    expect(Number.isFinite(u.totalSpendNanos)).toBe(true);
    expect(Number.isFinite(u.spendTodayNanos)).toBe(true);
    expect(u.totalSpendNanos).toBeGreaterThanOrEqual(0);
  });

  test("a NaN limit is rejected rather than admitting unlimited spend", async () => {
    const t = initTest();
    await expect(
      setUserLimits(t, "u", { dailySpendLimitNanos: NaN })
    ).rejects.toThrow(/dailySpendLimitNanos/);
    await expect(
      setUserLimits(t, "u", { dailySpendLimitNanos: Infinity })
    ).rejects.toThrow(/dailySpendLimitNanos/);
  });
});

describe("v1 hardening (round 2)", () => {
  test("a non-finite estimatedCostNanos is rejected before it can poison a bucket", async () => {
    const t = initTest();
    for (const estimatedCostNanos of [Infinity, NaN, -1]) {
      await expect(
        start(t, { userId: "u", estimatedCostNanos })
      ).rejects.toThrow(/estimatedCostNanos/);
    }
  });

  test("a settle with no cost signal falls back to the reserved estimate, not $0", async () => {
    const t = initTest();
    // $2 reserved up front (e.g. a video job).
    const r = await start(t, { userId: "u", estimatedCostNanos: 2_000_000_000 });
    // Settle with an unpriced server tool and no tokens/authoritative cost.
    const out = await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      serverToolUses: { video_seconds: 8 }, // no configured price
    });
    expect(out.costNanos).toBe(2_000_000_000); // NOT 0
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const u = await userOf(t, "u");
    expect(u.totalSpendNanos).toBe(2_000_000_000);
  });
});

describe("v1 hardening (round 3): reconcile phases", () => {
  test("expired tombstones are deleted after the late-settle horizon", async () => {
    vi.useFakeTimers();
    try {
      const t = initTest();
      const job = await start(t, { userId: "u", estimatedCostNanos: 100 });
      vi.advanceTimersByTime(31 * 60_000);
      // Expire it into a billing tombstone (reservationExpired + settled).
      await t.mutation(internal.lib.expirePhase, {});
      // Within the 7-day late-settle horizon: retention keeps the tombstone.
      await t.mutation(internal.lib.retentionPhase, {});
      expect(await t.run((ctx) => ctx.db.get(job.requestId))).not.toBeNull();
      // Past the horizon: the tombstone is deleted so they can't accumulate.
      vi.advanceTimersByTime(8 * 24 * 60 * 60_000);
      await t.mutation(internal.lib.retentionPhase, {});
      expect(await t.run((ctx) => ctx.db.get(job.requestId))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("v1: deployment policy (unpriced models, content storage)", () => {
  test("blocking unpriced models rejects a model with no configured price", async () => {
    const t = initTest();
    await t.mutation(api.lib.setDeploymentPolicy, { allowUnpricedModels: false });
    const r = await start(t, { userId: "u", model: "made/up-model" });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("model_unpriced");
    // A priced model still admits.
    expect((await start(t, { userId: "u", model: MODEL })).allowed).toBe(true);
  });

  test("storeContent:false keeps metadata but drops prompt/response content", async () => {
    const t = initTest();
    await t.mutation(api.lib.setDeploymentPolicy, { storeContent: false });
    const r = await start(t, { userId: "u" });
    await settleWith(t, r.requestId, {
      promptTokens: 10,
      completionTokens: 5,
      responseText: "secret answer",
    });
    const req = (await t.query(api.lib.getRequest, { requestId: r.requestId }))!;
    expect(req.messages).toEqual([]); // prompt not stored
    expect(req.responseText ?? undefined).toBe(undefined); // response not stored
    expect(req.promptTokens).toBe(10); // metadata/cost still recorded
  });
});
