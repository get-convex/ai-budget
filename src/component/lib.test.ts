import rateLimiterTest from "@convex-dev/rate-limiter/test";
import shardedCounterTest from "@convex-dev/sharded-counter/test";
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

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
  // finishRequest schedules the fold via runAfter(0); drain it, then drain the
  // rollup (uncapped totals + usage history land there, ~1 reconcile behind in
  // prod).
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
  await t.mutation(internal.lib.rollupPhase, {});
}
const setUserLimits = (t: any, userId: string, limits: any) =>
  t.mutation(api.lib.setBucketLimits, {
    dimension: "user",
    value: userId,
    ...limits,
  });
const bucketOf = async (t: any, dimension: string, value: string) =>
  (await t.query(api.lib.listBuckets, { dimension })).find(
    (b: any) => b.value === value,
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
  await t.mutation(internal.lib.rollupPhase, {});
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
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
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
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
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
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
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
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
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
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
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
    const pending = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
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
    await settleWith(t, r.requestId, {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
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
    await settleWith(t, r.requestId, {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
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
    const log = await t.query(api.lib.listAdjustments, {
      dimension: "user",
      value: "u",
    });
    expect(log.length).toBe(1);
    expect(log[0].deltaNanos).toBe(-250_000_000);
  });

  test("a credit grants headroom under a cap; a debit consumes gross spend", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { lifetimeSpendLimitNanos: 1_000_000_000 });
    const r = await start(t, { userId: "u" });
    await settleWith(t, r.requestId, { costNanos: 900_000_000 }); // $0.90 gross
    // Right at the edge: a $0.20 estimate would exceed the $1 cap...
    expect(
      (await start(t, { userId: "u", estimatedCostNanos: 200_000_000 }))
        .allowed,
    ).toBe(false);
    // ...but a $0.30 credit (net spend $0.60) reopens headroom.
    await t.mutation(api.lib.adjustBucket, {
      dimension: "user",
      value: "u",
      deltaNanos: -300_000_000,
    });
    expect(
      (await start(t, { userId: "u", estimatedCostNanos: 200_000_000 }))
        .allowed,
    ).toBe(true);
  });
});

describe("threshold alerts", () => {
  test("crossing warnAtPct returns a notice but still admits", async () => {
    const t = initTest();
    // One "hi" estimate is ~480_150 nano. Cap 800_000, warn at 50% (400_000).
    await setUserLimits(t, "u", {
      dailySpendLimitNanos: 800_000,
      warnAtPct: 0.5,
    });
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
        dimension: "action",
        value: "busy",
        requestsPerMinute: 1,
      });
      expect(
        (await start(t, { userId: "other", actionName: "busy" })).allowed,
      ).toBe(true);
      expect((await start(t, { userId: "u", actionName: "busy" })).code).toBe(
        "action_rate_limit",
      );
      expect(
        (await start(t, { userId: "u", actionName: "free" })).allowed,
      ).toBe(true);
      expect(
        (await start(t, { userId: "u", actionName: "free" })).allowed,
      ).toBe(true);
      expect(
        (await start(t, { userId: "u", actionName: "free" })).allowed,
      ).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(
        (await start(t, { userId: "u", actionName: "free" })).allowed,
      ).toBe(true);
      expect(
        (await start(t, { userId: "u", actionName: "free" })).allowed,
      ).toBe(false);
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
    for (const requestsPerMinute of [
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
    ]) {
      await expect(
        setUserLimits(t, "u", { requestsPerMinute }),
      ).rejects.toThrow(/requestsPerMinute/);
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
    await start(t, {
      userId: "u",
      tags: [{ dimension: "customer", value: "acme" }],
    });
    await start(t, {
      userId: "u",
      tags: [{ dimension: "customer", value: "globex" }],
    });
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
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
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
        }),
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
    // Conservative fallback is the most expensive KNOWN model (Opus-class
    // {$15 in, $75 out}/Mtok), so 1M in + 1M out => $90 = 90e9 nano. Over-count is
    // still the safe direction, without the old arbitrary $20/$100 that blocked
    // concurrency under small caps.
    expect(u.totalSpendNanos).toBe(90_000_000_000);
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
    expect(req.unpricedModel).toBe(true);
  });
});

describe("accounting lifecycle regressions", () => {
  test("old-day and old-month settlements preserve new holds", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
      const t = initTest();
      await setUserLimits(t, "u", {
        dailySpendLimitNanos: 1000,
        monthlySpendLimitNanos: 1000,
      });
      const old = await start(t, { userId: "u", estimatedCostNanos: 100 });
      vi.setSystemTime(new Date("2026-10-01T00:01:00Z"));
      await start(t, { userId: "u", estimatedCostNanos: 100 });
      await t.mutation(api.lib.finishRequest, {
        requestId: old.requestId,
        costNanos: 0,
      });
      await t.mutation(internal.lib.foldTotals, { requestId: old.requestId });
      const b = await userOf(t, "u");
      expect(b.reservedTodayNanos).toBe(100);
      expect(b.reservedMonthNanos).toBe(100);
      expect(b.reservedTotalNanos).toBe(100);
      expect(b.pendingCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a request admitted before caps were enabled cannot release a later hold", async () => {
    const t = initTest();
    const old = await start(t, { userId: "u", estimatedCostNanos: 100 });
    await setUserLimits(t, "u", { dailySpendLimitNanos: 1000 });
    expect(
      (await start(t, { userId: "u", estimatedCostNanos: 100 })).code,
    ).toBe("bucket_reconciling");
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    await start(t, { userId: "u", estimatedCostNanos: 100 });
    await t.mutation(api.lib.finishRequest, {
      requestId: old.requestId,
      costNanos: 0,
    });
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
      await t.mutation(api.lib.finishRequest, {
        requestId: job.requestId,
        costNanos: 75,
      });
      await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
      await t.mutation(api.lib.finishRequest, {
        requestId: job.requestId,
        costNanos: 999,
      });
      await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
      const b = await userOf(t, "u");
      expect(b.totalSpendNanos).toBe(75);
      expect(b.totalRequests).toBe(1);
      expect(b.reservedTotalNanos).toBe(100);
      expect((await t.query(api.lib.getGlobalStatus, {})).spentTotalNanos).toBe(
        75,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("long TTL jobs cannot hide expired jobs", async () => {
    vi.useFakeTimers();
    try {
      const t = initTest();
      await t.run(async (ctx) => {
        for (let i = 0; i < 201; i++) {
          await ctx.db.insert("requests", {
            userId: "long",
            model: MODEL,
            messages: [],
            status: "pending",
            expiresAt: Date.now() + 86400_000,
            heldBucketIds: [],
          });
        }
      });
      const short = await start(t, { userId: "short" });
      vi.advanceTimersByTime(31 * 60_000);
      const result = await t.mutation(internal.lib.expirePhase, {});
      expect(result.expired).toBe(1);
      expect(
        (await t.run((ctx) => ctx.db.get(short.requestId))).reservationExpired,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("global accounting includes usage before limits are enabled", async () => {
    const t = initTest();
    const job = await start(t, { userId: "u" });
    await t.mutation(api.lib.finishRequest, {
      requestId: job.requestId,
      costNanos: 100,
    });
    await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
    expect((await t.query(api.lib.getGlobalStatus, {})).spentTotalNanos).toBe(
      100,
    );
    await t.mutation(api.lib.setGlobalLimits, { lifetimeSpendLimitNanos: 100 });
    // The killswitch trips out-of-band (H4): the reconciler's globalPhase
    // compares the sharded total to the cap and flags settings; admission reads
    // the flag. So a request admits until the flag is set, then blocks.
    expect(
      (await start(t, { userId: "u", estimatedCostNanos: 1 })).allowed,
    ).toBe(true);
    await t.mutation(internal.lib.globalPhase, {});
    expect(
      (await start(t, { userId: "u", estimatedCostNanos: 1 })).allowed,
    ).toBe(false);
  });

  test("settlement does not write admission policy, but changing limits does", async () => {
    const t = initTest();
    const job = await start(t, { userId: "u" });
    const before = await t.run((ctx) =>
      ctx.db.query("bucketPolicies").collect(),
    );
    await t.mutation(api.lib.finishRequest, {
      requestId: job.requestId,
      costNanos: 100,
    });
    await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
    expect(
      await t.run((ctx) => ctx.db.query("bucketPolicies").collect()),
    ).toEqual(before);
    await setUserLimits(t, "u", { blocked: true });
    expect((await start(t, { userId: "u" })).allowed).toBe(false);
  });
});

test("legacy pending rows acquire deadlines without starving newer expired work", async () => {
  vi.useFakeTimers();
  try {
    const t = initTest();
    await t.run(async (ctx) => {
      for (let i = 0; i < 201; i++) {
        await ctx.db.insert("requests", {
          userId: "legacy",
          model: MODEL,
          messages: [],
          status: "pending",
          reserveTtlMs: 86400_000,
        });
      }
    });
    const job = await start(t, { userId: "new" });
    vi.advanceTimersByTime(31 * 60_000);
    expect((await t.mutation(internal.lib.expirePhase, {})).expired).toBe(1);
    expect(
      (await t.run((ctx) => ctx.db.get(job.requestId))).reservationExpired,
    ).toBe(true);
    // The phase self-reschedules to backfill the remaining legacy rows in
    // batches; drain those scheduled continuations.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("requests")
          .withIndex("status_expires", (q) =>
            q.eq("status", "pending").eq("expiresAt", undefined),
          )
          .take(1),
      ),
    ).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("retention progresses past unresolved jobs", async () => {
  vi.useFakeTimers();
  try {
    const t = initTest();
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert("requests", {
          userId: "long",
          model: MODEL,
          messages: [],
          status: "pending",
          expiresAt: Date.now() + 86400_000,
        });
      }
    });
    const job = await start(t, { userId: "short" });
    await t.mutation(api.lib.finishRequest, {
      requestId: job.requestId,
      costNanos: 0,
    });
    await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
    vi.advanceTimersByTime(2 * 60 * 60_000);
    expect((await t.mutation(internal.lib.retentionPhase, {})).purged).toBe(1);
    expect(await t.run((ctx) => ctx.db.get(job.requestId))).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("delayed folding attributes spend to completion day and leaves newer holds intact", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
    const t = initTest();
    await setUserLimits(t, "u", { dailySpendLimitNanos: 1000 });
    const job = await start(t, { userId: "u", estimatedCostNanos: 100 });
    await t.mutation(api.lib.finishRequest, {
      requestId: job.requestId,
      costNanos: 50,
    });
    vi.setSystemTime(new Date("2026-10-01T00:01:00Z"));
    await start(t, { userId: "u", estimatedCostNanos: 100 });
    await t.mutation(internal.lib.foldTotals, { requestId: job.requestId });
    await t.mutation(internal.lib.rollupPhase, {}); // drain the settlement delta into usage
    const b = await userOf(t, "u");
    expect(b.spendTodayNanos).toBe(0);
    expect(b.reservedTodayNanos).toBe(100);
    const history = await t.query(api.lib.usageHistory, {
      dimension: "user",
      value: "u",
      period: "day",
    });
    expect(history[0].stamp).toBe("2026-09-30");
    expect(history[0].spendNanos).toBe(50);
  } finally {
    vi.useRealTimers();
  }
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
    await t.mutation(api.lib.setGlobalLimits, {
      lifetimeSpendLimitNanos: null,
    });
    const after = await t.query(api.lib.getGlobalStatus, {});
    expect(after.lifetimeSpendLimitNanos).toBe(null);
    expect(after.dailySpendLimitNanos).toBe(200);
  });

  test("finishRequest preserves a deleted user's late charge", async () => {
    const t = initTest();
    const r = await start(t, { userId: "u" });
    await t.mutation(api.lib.deleteBucket, { dimension: "user", value: "u" });
    // A sanitized tombstone preserves final billing without retaining the user.
    const out = await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      costNanos: 1_000_000,
    });
    expect(out.costNanos).toBe(1_000_000);
    expect(
      (await t.query(api.lib.getRequest, { requestId: r.requestId })).userId,
    ).toBe(`erased:${r.requestId}`);
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
      costNanos: NaN, // ignored (not finite) -> token pricing
      promptTokens: NaN, // coerced to 0
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
      setUserLimits(t, "u", { dailySpendLimitNanos: NaN }),
    ).rejects.toThrow(/dailySpendLimitNanos/);
    await expect(
      setUserLimits(t, "u", { dailySpendLimitNanos: Infinity }),
    ).rejects.toThrow(/dailySpendLimitNanos/);
  });
});

describe("v1 hardening (round 2)", () => {
  test("a non-finite estimatedCostNanos is rejected before it can poison a bucket", async () => {
    const t = initTest();
    for (const estimatedCostNanos of [Infinity, NaN, -1]) {
      await expect(
        start(t, { userId: "u", estimatedCostNanos }),
      ).rejects.toThrow(/estimatedCostNanos/);
    }
  });

  test("a settle with no cost signal falls back to the reserved estimate, not $0", async () => {
    const t = initTest();
    // $2 reserved up front (e.g. a video job).
    const r = await start(t, {
      userId: "u",
      estimatedCostNanos: 2_000_000_000,
    });
    // Settle with an unpriced server tool and no tokens/authoritative cost.
    const out = await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      serverToolUses: { video_seconds: 8 }, // no configured price
    });
    expect(out.costNanos).toBe(2_000_000_000); // NOT 0
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    await t.mutation(internal.lib.rollupPhase, {}); // drain uncapped totals
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
    await t.mutation(api.lib.setDeploymentPolicy, {
      allowUnpricedModels: false,
    });
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
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
    expect(req.messages).toEqual([]); // prompt not stored
    expect(req.responseText ?? undefined).toBe(undefined); // response not stored
    expect(req.promptTokens).toBe(10); // metadata/cost still recorded
  });
});

describe("v1: Convex byte-limit hardening", () => {
  test("a huge prompt is truncated for storage but estimated at full size", async () => {
    const t = initTest();
    const huge = "x".repeat(500_000);
    const r = await start(t, {
      userId: "u",
      messages: [{ role: "user", content: huge }],
    });
    expect(r.allowed).toBe(true);
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
    const stored = req.messages.reduce(
      (n: number, m: any) => n + m.content.length,
      0,
    );
    expect(stored).toBeLessThanOrEqual(20_000); // row stays far under 1 MiB
    // The token estimate still reflects the full prompt, so a tiny cap blocks it.
    await setUserLimits(t, "u2", { dailyTokenLimit: 1000 });
    const blocked = await start(t, {
      userId: "u2",
      messages: [{ role: "user", content: huge }],
    });
    expect(blocked.allowed).toBe(false);
  });

  test("a huge responseText is truncated for storage", async () => {
    const t = initTest();
    const r = await start(t, { userId: "u" });
    await settleWith(t, r.requestId, {
      promptTokens: 1,
      completionTokens: 1,
      responseText: "y".repeat(200_000),
    });
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
    expect((req.responseText ?? "").length).toBeLessThanOrEqual(20_000);
  });

  test("excess attribution tags are rejected rather than silently dropping budget dimensions", async () => {
    const t = initTest();
    const tags = Array.from({ length: 17 }, (_, i) => ({
      dimension: `tag${i}`,
      value: "v",
    }));
    await expect(start(t, { userId: "u", tags })).rejects.toThrow(/At most 16/);
    expect(await t.query(api.lib.listRequests, {})).toHaveLength(0);
  });

  test("listRequests clamps the page size and strips content", async () => {
    const t = initTest();
    const r = await start(t, {
      userId: "u",
      messages: [{ role: "user", content: "hello" }],
    });
    await settleWith(t, r.requestId, {
      promptTokens: 10,
      completionTokens: 5,
      responseText: "a response",
    });
    const rows = await t.query(api.lib.listRequests, {
      userId: "u",
      limit: 10_000_000,
    });
    expect(rows.length).toBeLessThanOrEqual(200);
    expect(rows[0].messages).toEqual([]);
    expect(rows[0].responseText ?? undefined).toBe(undefined);
  });
});

describe("v1: H6 fold de-contention", () => {
  test("an uncapped shared bucket is folded via the rollup, not on the settle path", async () => {
    const t = initTest();
    // Two requests attributed to a shared, UNCAPPED action bucket.
    for (const i of [1, 2]) {
      const r = await start(t, { userId: `u${i}`, actionName: "shared" });
      await t.mutation(api.lib.finishRequest, {
        requestId: r.requestId,
        costNanos: 100_000_000,
      });
    }
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers); // fold -> append deltas
    vi.useRealTimers();
    // The shared action row is NOT written on the hot settle path (no
    // contention): its total is still 0, the spend sits in queued deltas.
    const before = await bucketOf(t, "action", "shared");
    expect(before?.totalSpendNanos ?? 0).toBe(0);
    const deltas = await t.run((ctx: any) =>
      ctx.db.query("usageDeltas").collect(),
    );
    expect(deltas.length).toBeGreaterThan(0);
    // The reconciler's rollup drains them into the row + usage history.
    await t.mutation(internal.lib.rollupPhase, {});
    const after = await bucketOf(t, "action", "shared");
    expect(after.totalSpendNanos).toBe(200_000_000);
    expect(after.totalRequests).toBe(2);
    const hist = await t.query(api.lib.usageHistory, {
      dimension: "action",
      value: "shared",
      period: "day",
    });
    expect(hist[0].spendNanos).toBe(200_000_000);
    expect(
      await t.run((ctx: any) => ctx.db.query("usageDeltas").collect()),
    ).toHaveLength(0);
  });

  test("a capped bucket is updated live and NOT double-counted by the rollup", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { lifetimeSpendLimitNanos: 1_000_000_000 });
    const r = await start(t, { userId: "u" });
    // finish + fold (capped row updated live)...
    await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      costNanos: 300_000_000,
    });
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    expect((await userOf(t, "u")).totalSpendNanos).toBe(300_000_000); // live
    // ...draining the rollup must NOT add it again.
    await t.mutation(internal.lib.rollupPhase, {});
    expect((await userOf(t, "u")).totalSpendNanos).toBe(300_000_000);
  });
});

describe("security review regressions", () => {
  const drain = async (t: any) => {
    vi.useFakeTimers();
    try {
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
  };

  test("daily and monthly credits expire when admission advances the calendar", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
      const t = initTest();
      await setUserLimits(t, "u", {
        dailySpendLimitNanos: 100,
        monthlySpendLimitNanos: 100,
      });
      await t.mutation(api.lib.adjustBucket, {
        dimension: "user",
        value: "u",
        deltaNanos: -100,
      });
      vi.setSystemTime(new Date("2026-10-01T00:01:00Z"));
      expect(
        (await start(t, { userId: "u", estimatedCostNanos: 60 })).allowed,
      ).toBe(true);
      expect(
        (await start(t, { userId: "u", estimatedCostNanos: 60 })).allowed,
      ).toBe(false);
      const b = await userOf(t, "u");
      expect(b.creditsTodayNanos).toBe(0);
      expect(b.creditsThisMonthNanos).toBe(0);
      expect(b.creditsNanos).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([true, false])(
    "settlement and rollup expire old credits (capped=%s)",
    async (capped) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
        const t = initTest();
        if (capped) {
          await setUserLimits(t, "u", {
            dailySpendLimitNanos: 1000,
            monthlySpendLimitNanos: 1000,
          });
        }
        await t.mutation(api.lib.adjustBucket, {
          dimension: "user",
          value: "u",
          deltaNanos: -100,
        });
        const r = await start(t, { userId: "u", estimatedCostNanos: 10 });
        vi.setSystemTime(new Date("2026-10-01T00:01:00Z"));
        await t.mutation(api.lib.finishRequest, {
          requestId: r.requestId,
          costNanos: 10,
        });
        await t.mutation(internal.lib.foldTotals, { requestId: r.requestId });
        await t.mutation(internal.lib.rollupPhase, {});
        const b = await userOf(t, "u");
        expect(b.creditsTodayNanos).toBe(0);
        expect(b.creditsThisMonthNanos).toBe(0);
        expect(b.spendTodayNanos).toBe(10);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("cap activation drains prior spend and adopts existing holds before admitting", async () => {
    const t = initTest();
    const done = await start(t, { userId: "u", estimatedCostNanos: 100 });
    await t.mutation(api.lib.finishRequest, {
      requestId: done.requestId,
      costNanos: 600,
    });
    await t.mutation(internal.lib.foldTotals, { requestId: done.requestId });
    const pending = await start(t, { userId: "u", estimatedCostNanos: 300 });
    await setUserLimits(t, "u", {
      lifetimeSpendLimitNanos: 1000,
      maxConcurrent: 1,
    });
    expect((await start(t, { userId: "u", estimatedCostNanos: 1 })).code).toBe(
      "bucket_reconciling",
    );
    await drain(t);
    const b = await userOf(t, "u");
    expect(b.totalSpendNanos).toBe(600);
    expect(b.reservedTotalNanos).toBe(300);
    expect(b.pendingCount).toBe(1);
    expect((await start(t, { userId: "u", estimatedCostNanos: 1 })).code).toBe(
      "user_max_concurrent",
    );
    await t.mutation(api.lib.finishRequest, {
      requestId: pending.requestId,
      costNanos: 300,
    });
    await drain(t);
    expect(
      (await start(t, { userId: "u", estimatedCostNanos: 101 })).allowed,
    ).toBe(false);
  });

  test("tag cap activation scans multiple pages without double counting", async () => {
    const t = initTest();
    for (let i = 0; i < 30; i++) {
      await start(t, {
        userId: `u${i}`,
        tags: [{ dimension: "team", value: "a" }],
        estimatedCostNanos: 10,
      });
    }
    await t.mutation(api.lib.setBucketLimits, {
      dimension: "team",
      value: "a",
      maxConcurrent: 30,
    });
    await drain(t);
    const b = await bucketOf(t, "team", "a");
    expect(b.pendingCount).toBe(30);
    expect(b.reservedTotalNanos).toBe(300);
    expect(
      (
        await start(t, {
          userId: "new",
          tags: [{ dimension: "team", value: "a" }],
          estimatedCostNanos: 10,
        })
      ).allowed,
    ).toBe(false);
  });

  test("global bumps and server tool prices reject poison and overflow", async () => {
    const t = initTest();
    for (const amount of [
      -1,
      NaN,
      Infinity,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(
        t.mutation(api.lib.bumpGlobal, { dailyNanos: amount }),
      ).rejects.toThrow();
      await expect(
        t.mutation(api.lib.setServerToolPrice, {
          tool: "x",
          nanosPerCall: amount,
        }),
      ).rejects.toThrow();
    }
    await t.mutation(api.lib.bumpGlobal, {
      lifetimeNanos: Number.MAX_SAFE_INTEGER,
    });
    await expect(
      t.mutation(api.lib.bumpGlobal, { lifetimeNanos: 1 }),
    ).rejects.toThrow(/safe integer/);
    await expect(
      t.mutation(api.lib.setRetention, { retentionMs: NaN }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.lib.setAlertDefaults, { warnAtPct: 1.1 }),
    ).rejects.toThrow();
  });

  test("unsafe settlement and tool counts cannot reach the ledger", async () => {
    const t = initTest();
    const r = await start(t, { userId: "u" });
    await expect(
      t.mutation(api.lib.finishRequest, {
        requestId: r.requestId,
        costNanos: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.lib.finishRequest, {
        requestId: r.requestId,
        serverToolUses: { web_search: Infinity },
      }),
    ).rejects.toThrow();
    expect(
      (await t.query(api.lib.getRequest, { requestId: r.requestId })).status,
    ).toBe("pending");
  });

  test("prices are frozen at admission including cache reads, writes and tools", async () => {
    const t = initTest();
    await t.mutation(api.lib.setPrice, {
      model: MODEL,
      inputNanosPerMTok: 1_000_000,
      outputNanosPerMTok: 2_000_000,
      cachedNanosPerMTok: 100_000,
      cacheWriteNanosPerMTok: 1_250_000,
    });
    const r = await start(t, { userId: "u" });
    await t.mutation(api.lib.setPrice, {
      model: MODEL,
      inputNanosPerMTok: 0,
      outputNanosPerMTok: 0,
    });
    await t.mutation(api.lib.setServerToolPrice, {
      tool: "web_search",
      nanosPerCall: 0,
    });
    const out = await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      promptTokens: 300,
      cachedTokens: 100,
      cachedWriteTokens: 100,
      cachedWrite1hTokens: 50,
      completionTokens: 10,
      serverToolUses: { web_search: 1 },
    });
    expect(out.costNanos).toBe(10_000_293);
  });

  test("deleted user tombstones charge once and never restore content or buckets", async () => {
    const t = initTest();
    const r = await start(t, { userId: "u", actionName: "shared" });
    await t.mutation(api.lib.deleteBucket, { dimension: "user", value: "u" });
    expect((await start(t, { userId: "u" })).code).toBe("bucket_deleted");
    await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      responseText: "private",
      error: "private",
      costNanos: 123,
    });
    await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      costNanos: 999,
    });
    await drain(t);
    await t.mutation(internal.lib.rollupPhase, {});
    const req = await t.query(api.lib.getRequest, { requestId: r.requestId });
    expect(req.userId).toBe(`erased:${r.requestId}`);
    expect(req.responseText).toBeUndefined();
    expect(req.error).toBe("provider_error");
    expect(await userOf(t, "u")).toBeUndefined();
    expect(await userOf(t, "erased")).toBeUndefined();
    expect((await bucketOf(t, "action", "shared")).totalSpendNanos).toBe(123);
    expect((await t.query(api.lib.getGlobalStatus, {})).spentTotalNanos).toBe(
      123,
    );
    const events = await t.run((ctx) =>
      ctx.db.query("billingEvents").collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0].costNanos).toBe(123);
  });

  test("deletion removes user history and old deltas cannot recreate a new generation", async () => {
    const t = initTest();
    await t.mutation(api.lib.adjustBucket, {
      dimension: "user",
      value: "u",
      deltaNanos: 12,
      reason: "private",
    });
    const r = await start(t, { userId: "u" });
    await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      costNanos: 50,
    });
    await t.mutation(internal.lib.foldTotals, { requestId: r.requestId });
    await t.mutation(api.lib.deleteBucket, { dimension: "user", value: "u" });
    await setUserLimits(t, "u", { dailySpendLimitNanos: 100 });
    await t.mutation(internal.lib.rollupPhase, {});
    expect((await userOf(t, "u")).totalSpendNanos).toBe(0);
    expect(
      await t.query(api.lib.usageHistory, {
        dimension: "user",
        value: "u",
        period: "day",
      }),
    ).toEqual([]);
    expect(
      await t.query(api.lib.listAdjustments, { dimension: "user", value: "u" }),
    ).toEqual([]);
    await t.mutation(api.lib.deleteBucket, { dimension: "user", value: "u" });
    expect(await userOf(t, "u")).toBeUndefined();
  });

  test("privacy policy sanitizes provider errors", async () => {
    const t = initTest();
    await t.mutation(api.lib.setDeploymentPolicy, { storeContent: false });
    const r = await start(t, { userId: "u", messages: msg("secret") });
    await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      error: "secret prompt https://key",
      costNanos: 0,
    });
    const req = await t.query(api.lib.getRequest, { requestId: r.requestId });
    expect(req.messages).toEqual([]);
    expect(req.error).toBe("provider_error");
  });

  test("null clears bucket controls while omitted controls survive", async () => {
    const t = initTest();
    await setUserLimits(t, "u", {
      dailySpendLimitNanos: 100,
      monthlySpendLimitNanos: 200,
      blocked: true,
    });
    await setUserLimits(t, "u", { dailySpendLimitNanos: null, blocked: null });
    const b = await userOf(t, "u");
    expect(b.dailySpendLimitNanos).toBeUndefined();
    expect(b.blocked).toBeUndefined();
    expect(b.monthlySpendLimitNanos).toBe(200);
  });

  test("reactive reporting clock normalizes every daily and monthly field", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-30T23:59:00Z"));
      const t = initTest();
      await setUserLimits(t, "u", {
        dailySpendLimitNanos: 1000,
        monthlySpendLimitNanos: 1000,
      });
      await t.mutation(api.lib.adjustBucket, {
        dimension: "user",
        value: "u",
        deltaNanos: -100,
      });
      await start(t, { userId: "u", estimatedCostNanos: 100 });
      await t.mutation(internal.lib.globalPhase, {});
      vi.setSystemTime(new Date("2026-10-01T00:01:00Z"));
      await t.mutation(internal.lib.globalPhase, {});
      const b = await t.query(api.lib.getBucket, {
        dimension: "user",
        value: "u",
      });
      expect(b.creditsTodayNanos).toBe(0);
      expect(b.creditsThisMonthNanos).toBe(0);
      expect(b.reservedTodayTokens).toBe(0);
      expect(b.reservedMonthNanos).toBe(0);
      expect(b.tokensToday).toBe(0);
      expect(b.reservedTotalNanos).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  test("idempotency keys reserve once and reject changed payloads", async () => {
    const t = initTest();
    await setUserLimits(t, "u", { maxConcurrent: 1 });
    const first = await start(t, { userId: "u", idempotencyKey: "job" });
    const again = await start(t, { userId: "u", idempotencyKey: "job" });
    expect(again.requestId).toBe(first.requestId);
    expect(again.reused).toBe(true);
    expect((await userOf(t, "u")).pendingCount).toBe(1);
    await expect(
      start(t, {
        userId: "u",
        idempotencyKey: "job",
        messages: msg("changed"),
      }),
    ).rejects.toThrow(/different arguments/);
  });

  test("bucket pagination returns all buckets across pages", async () => {
    const t = initTest();
    for (let i = 0; i < 6; i++) await setUserLimits(t, `u${i}`, {});
    const first = await t.query(api.lib.paginateBuckets, {
      dimension: "user",
      paginationOpts: { cursor: null, numItems: 3 },
    });
    const second = await t.query(api.lib.paginateBuckets, {
      dimension: "user",
      paginationOpts: { cursor: first.continueCursor, numItems: 3 },
    });
    expect(
      new Set([...first.page, ...second.page].map((b) => b.value)).size,
    ).toBe(6);
    await expect(
      t.query(api.lib.usageHistory, {
        dimension: "user",
        value: "u",
        period: "day",
        limit: Infinity,
      }),
    ).rejects.toThrow();
  });
});

test("explicit reservation policy refuses heuristic spend and token holds", async () => {
  const t = initTest();
  await t.mutation(api.lib.setDeploymentPolicy, {
    requireExplicitReservations: true,
  });
  expect((await start(t, { userId: "u" })).code).toBe(
    "explicit_reservation_required",
  );
  expect((await start(t, { userId: "u", estimatedCostNanos: 100 })).code).toBe(
    "explicit_reservation_required",
  );
  await setUserLimits(t, "u", { dailyTokenLimit: 10 });
  const r = await start(t, {
    userId: "u",
    estimatedCostNanos: 100,
    estimatedTokens: 10,
  });
  expect(r.allowed).toBe(true);
  expect((await userOf(t, "u")).reservedTotalTokens).toBe(10);
});

test("Unicode prompt and response retention obeys byte limits", async () => {
  const t = initTest();
  const r = await start(t, { userId: "u", messages: msg("🙂".repeat(50_000)) });
  await t.mutation(api.lib.finishRequest, {
    requestId: r.requestId,
    responseText: "🙂".repeat(50_000),
    costNanos: 1,
  });
  const req = await t.query(api.lib.getRequest, { requestId: r.requestId });
  const encode = (text: string) => new TextEncoder().encode(text).length;
  expect(
    req.messages.reduce((n, m) => n + encode(m.content), 0),
  ).toBeLessThanOrEqual(16 * 1024);
  expect(encode(req.responseText!)).toBeLessThanOrEqual(16 * 1024);
});

test("the durable billing ledger survives request retention", async () => {
  const t = initTest();
  const r = await start(t, { userId: "u" });
  await settleWith(t, r.requestId, { costNanos: 321 });
  await t.mutation(api.lib.setRetention, { retentionMs: 1 });
  vi.useFakeTimers();
  try {
    vi.advanceTimersByTime(100);
    await t.mutation(internal.lib.retentionPhase, {});
    expect(
      await t.query(api.lib.getRequest, { requestId: r.requestId }),
    ).toBeNull();
    expect(
      (await t.query(api.lib.getBillingEvent, { requestId: r.requestId }))
        ?.costNanos,
    ).toBe(321);
  } finally {
    vi.useRealTimers();
  }
});

test("admin changes produce actor-attributed audit events", async () => {
  const t = initTest();
  await t.mutation(api.lib.setGlobalLimits, {
    dailySpendLimitNanos: 100,
    actorId: "admin-a",
  });
  const events = await t.query(api.lib.paginateAdminEvents, {
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(events.page[0].actorId).toBe("admin-a");
  expect(events.page[0].operation).toBe("setGlobalLimits");
});

test("credits do not hide one-nanodollar violations through floating-point cancellation", async () => {
  const t = initTest();
  await setUserLimits(t, "u", { lifetimeSpendLimitNanos: 1 });
  await t.run(async (ctx) => {
    const b = (await ctx.db
      .query("buckets")
      .withIndex("dim_value", (q) => q.eq("dimension", "user").eq("value", "u"))
      .unique())!;
    await ctx.db.patch(b._id, {
      totalSpendNanos: Number.MAX_SAFE_INTEGER,
      creditsNanos: Number.MAX_SAFE_INTEGER,
      reservedTotalNanos: 1,
    });
  });
  expect((await start(t, { userId: "u", estimatedCostNanos: 1 })).allowed).toBe(
    false,
  );
});

test("token pricing rounds exact integer intermediates", async () => {
  const t = initTest();
  const rate = Number.MAX_SAFE_INTEGER;
  await t.mutation(api.lib.setPrice, {
    model: MODEL,
    inputNanosPerMTok: 0,
    outputNanosPerMTok: rate,
  });
  const r = await start(t, { userId: "u" });
  const out = await t.mutation(api.lib.finishRequest, {
    requestId: r.requestId,
    completionTokens: 100_001,
  });
  expect(out.costNanos).toBe(
    Number((100_001n * BigInt(rate) + 500_000n) / 1_000_000n),
  );
});

test("raw provider errors require explicit diagnostic retention", async () => {
  const t = initTest();
  const first = await start(t, { userId: "u" });
  await t.mutation(api.lib.finishRequest, {
    requestId: first.requestId,
    error: "private diagnostic",
    costNanos: 0,
  });
  expect(
    (await t.query(api.lib.getRequest, { requestId: first.requestId })).error,
  ).toBe("provider_error");
  await t.mutation(api.lib.setDeploymentPolicy, { storeRawErrors: true });
  const second = await start(t, { userId: "u" });
  await t.mutation(api.lib.finishRequest, {
    requestId: second.requestId,
    error: "retained diagnostic",
    costNanos: 0,
  });
  expect(
    (await t.query(api.lib.getRequest, { requestId: second.requestId })).error,
  ).toBe("retained diagnostic");
});

test("long-running jobs retain a full late-settlement horizon after expiry", async () => {
  vi.useFakeTimers();
  try {
    const t = initTest();
    const r = await start(t, {
      userId: "u",
      reserveTtlMs: 10 * 24 * 60 * 60 * 1000,
    });
    vi.advanceTimersByTime(11 * 24 * 60 * 60 * 1000);
    await t.mutation(internal.lib.expirePhase, {});
    await t.mutation(internal.lib.retentionPhase, {});
    expect(
      await t.query(api.lib.getRequest, { requestId: r.requestId }),
    ).not.toBeNull();
    vi.advanceTimersByTime(6 * 24 * 60 * 60 * 1000);
    const out = await t.mutation(api.lib.finishRequest, {
      requestId: r.requestId,
      costNanos: 50,
    });
    expect(out.costNanos).toBe(50);
    await t.mutation(internal.lib.foldTotals, { requestId: r.requestId });
    await t.mutation(internal.lib.retentionPhase, {});
    expect(
      await t.query(api.lib.getRequest, { requestId: r.requestId }),
    ).toBeNull();
    expect(
      (
        await t.mutation(api.lib.finishRequest, {
          requestId: r.requestId,
          costNanos: 999,
        })
      ).costNanos,
    ).toBe(50);
  } finally {
    vi.useRealTimers();
  }
});

describe("security review fixes: overflow, audit retention, bounded admin inputs", () => {
  test("H1: a lifetime total crossing 2^53 saturates on settle instead of wedging the fold", async () => {
    const t = initTest();
    // Capped bucket so foldOne live-patches its row on settle.
    await setUserLimits(t, "whale", { dailySpendLimitNanos: 10_000_000_000 }); // $10/day, admits
    const r = await start(t, { userId: "whale" });
    expect(r.allowed).toBe(true);
    // Push the lifetime total to the brink of the safe-integer ceiling.
    await t.run(async (ctx: any) => {
      const b = await ctx.db
        .query("buckets")
        .withIndex("dim_value", (q: any) =>
          q.eq("dimension", "user").eq("value", "whale"),
        )
        .unique();
      await ctx.db.patch(b._id, {
        totalSpendNanos: Number.MAX_SAFE_INTEGER - 100,
      });
    });
    // Settling a real $0.75 charge would overflow the lifetime total. It must NOT
    // throw (a throw rolls back the fold and makes foldPhase retry forever); it
    // saturates, the request settles, and the reservation is released.
    await settle(t, r.requestId, 1_000_000, 1_000_000);
    const u = await userOf(t, "whale");
    expect(u.totalSpendNanos).toBe(Number.MAX_SAFE_INTEGER);
    expect(u.totalRequests).toBe(1);
    expect(u.reservedTotalNanos ?? 0).toBe(0);
  });

  test("H2: deleting a bucket retains its admin audit trail, including the deletion event", async () => {
    const t = initTest();
    await t.mutation(api.lib.setBucketLimits, {
      dimension: "user",
      value: "alice",
      dailySpendLimitNanos: 1_000_000_000,
      actorId: "admin1",
    });
    await t.mutation(api.lib.adjustBucket, {
      dimension: "user",
      value: "alice",
      deltaNanos: -500,
      reason: "comp",
      actorId: "admin1",
    });
    await t.mutation(api.lib.deleteBucket, {
      dimension: "user",
      value: "alice",
      actorId: "admin2",
    });
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const events = await t.query(api.lib.paginateAdminEvents, {
      paginationOpts: { numItems: 50, cursor: null },
    });
    const ops = events.page.map((e: any) => e.operation);
    expect(ops).toContain("deleteBucket"); // the most sensitive op is itself auditable
    expect(ops).toContain("setBucketLimits");
    expect(ops).toContain("adjustBucket");
    const del = events.page.find((e: any) => e.operation === "deleteBucket");
    expect(del.actorId).toBe("admin2");
    expect(del.value).toBe("alice");
  });

  test("M2: oversized admin inputs are bounded, not rejected and not doc-blowing", async () => {
    const t = initTest();
    await t.mutation(api.lib.adjustBucket, {
      dimension: "user",
      value: "u",
      deltaNanos: 1000,
      reason: "x".repeat(50_000),
      actorId: "a",
    });
    await t.mutation(api.lib.setModelPolicy, {
      mode: "allowlist",
      models: Array(1500).fill("m".repeat(300)),
      actorId: "a",
    });
    const pol = await t.query(api.lib.getModelPolicy, {});
    expect(pol.models.length).toBeLessThanOrEqual(1000);
    expect(pol.models.every((m: string) => m.length <= 256)).toBe(true);
    const reason: string = await t.run(
      async (ctx: any) =>
        (await ctx.db.query("adjustments").collect())[0].reason,
    );
    expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(
      2 * 1024 + 4,
    );
    const events = await t.query(api.lib.paginateAdminEvents, {
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(
      events.page.every(
        (e: any) =>
          new TextEncoder().encode(e.detailsJson).length <= 8 * 1024 + 4,
      ),
    ).toBe(true);
  });
});

describe("security review fixes (round 2): explicit reservations, index, pricing", () => {
  test("M4: requireExplicitReservations rejects a 0/0 (or omitted) reservation", async () => {
    const t = initTest();
    await t.mutation(api.lib.setDeploymentPolicy, {
      requireExplicitReservations: true,
    });
    // A 0/0 reservation reserves nothing — it must be rejected, not admitted.
    const zero = await start(t, {
      userId: "u",
      estimatedCostNanos: 0,
      estimatedTokens: 0,
    });
    expect(zero.allowed).toBe(false);
    expect(zero.code).toBe("explicit_reservation_required");
    // Omitted bounds: still rejected.
    const missing = await start(t, { userId: "u" });
    expect(missing.allowed).toBe(false);
    expect(missing.code).toBe("explicit_reservation_required");
    // Positive explicit bounds: admitted.
    const ok = await start(t, {
      userId: "u",
      estimatedCostNanos: 1_000_000,
      estimatedTokens: 100,
    });
    expect(ok.allowed).toBe(true);
  });

  test("buckets dimension-only listing still works off the compound index", async () => {
    const t = initTest();
    await setUserLimits(t, "a", { dailySpendLimitNanos: 1_000_000_000 });
    await setUserLimits(t, "b", { dailySpendLimitNanos: 1_000_000_000 });
    const users = (
      await t.query(api.lib.listBuckets, { dimension: "user" })
    ).map((x: any) => x.value);
    expect(users.sort()).toEqual(["a", "b"]);
  });

  test("server-tool pricing is integer-exact and bounded", async () => {
    const t = initTest();
    await t.mutation(api.lib.setServerToolPrice, {
      tool: "image",
      nanosPerCall: 50_000_000,
    });
    const r = await start(t, { userId: "u" });
    await settleWith(t, r.requestId, {
      promptTokens: 0,
      completionTokens: 0,
      serverToolUses: { image: 3 },
    });
    const got = await t.query(api.lib.getRequest, { requestId: r.requestId });
    expect(got.costNanos).toBe(150_000_000); // 3 × $0.05, exact
  });
});

describe("identity upgrades preserve budget enforcement", () => {
  test("issuer-scoped admission cannot bypass a legacy capped bucket", async () => {
    const t = initTest();
    await setUserLimits(t, "same", { dailySpendLimitNanos: 1 });
    for (const userId of ["issuer-a|same", "issuer-b|same"]) {
      const r = await start(t, { userId, legacyUserId: "same" });
      expect(r).toMatchObject({
        allowed: false,
        code: "identity_migration_required",
      });
      expect(await userOf(t, userId)).toBeUndefined();
    }
    const legacy = await start(t, { userId: "same" });
    expect(legacy).toMatchObject({
      allowed: false,
      code: "user_daily_spend_limit",
    });
  });
  test("fresh identities admit normally without an old subject bucket", async () => {
    const t = initTest();
    const r = await start(t, { userId: "issuer|fresh", legacyUserId: "fresh" });
    expect(r.allowed).toBe(true);
  });
});

test("issuer migration cannot bypass a legacy deletion marker", async () => {
  const t = initTest();
  await setUserLimits(t, "deleted-subject", {});
  await t.mutation(api.lib.deleteBucket, {
    dimension: "user",
    value: "deleted-subject",
  });
  const r = await start(t, {
    userId: "issuer|deleted-subject",
    legacyUserId: "deleted-subject",
  });
  expect(r).toMatchObject({
    allowed: false,
    code: "identity_migration_required",
  });
  expect(await userOf(t, "issuer|deleted-subject")).toBeUndefined();
});

describe("1.1.1 fixes: failure billing, default prices, global enforcement", () => {
  test("B4: a failed call is NOT charged its reserved estimate", async () => {
    const t = initTest();
    await setUserLimits(t, "fail-u", { dailySpendLimitNanos: 1_000_000_000 });
    const r = await start(t, {
      userId: "fail-u",
      estimatedCostNanos: 500_000_000,
    }); // reserve $0.50
    expect(r.allowed).toBe(true);
    await settleWith(t, r.requestId, { error: "provider boom" }); // failed, no usage signal
    const u = await userOf(t, "fail-u");
    expect(u.totalSpendNanos).toBe(0); // no charge on failure
    expect(u.reservedTotalNanos ?? 0).toBe(0); // reservation released
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
    expect(req.status).toBe("error");
    expect(req.costNanos).toBe(0);
  });

  test("B4: a SUCCESSFUL no-usage call still falls back to the reserved estimate", async () => {
    const t = initTest();
    const r = await start(t, {
      userId: "succ-u",
      estimatedCostNanos: 500_000_000,
    });
    expect(r.allowed).toBe(true);
    await settleWith(t, r.requestId, {}); // success, no tokens/cost signal
    const u = await userOf(t, "succ-u");
    expect(u.totalSpendNanos).toBe(500_000_000); // charged the estimate (fail-closed)
  });

  test("B6: current models carry real default prices (not the fallback)", async () => {
    const t = initTest();
    const r = await start(t, {
      userId: "s5",
      model: "anthropic/claude-sonnet-5",
    });
    await settle(t, r.requestId, 1_000_000, 1_000_000); // 1M in + 1M out
    const u = await userOf(t, "s5");
    expect(u.totalSpendNanos).toBe(18_000_000_000); // $3 in + $15 out, NOT the $90 fallback
    const req = (await t.query(api.lib.getRequest, {
      requestId: r.requestId,
    }))!;
    expect(req.unpricedModel).not.toBe(true);
  });

  test("B2/B8: global enforcement accepts 'hard' (legacy value + intuitive name)", async () => {
    const t = initTest();
    await t.mutation(api.lib.setGlobalLimits, {
      dailySpendLimitNanos: 1_000_000_000,
      enforcement: "hard",
    });
    const status = await t.query(api.lib.getGlobalStatus, {});
    expect(status.enforcement).toBe("hard");
  });
});
