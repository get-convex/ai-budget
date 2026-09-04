import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const vMessage = v.object({
  role: v.string(), // "system" | "user" | "assistant" | "tool"
  content: v.string(),
});

// One attribution tag: a (dimension, value) pair, e.g. {dimension:"user",
// value:"alice"} or {dimension:"customer", value:"acme"}. `user` and `action`
// are built-in dimensions; apps can add any others (team, project, env, …).
export const vTag = v.object({ dimension: v.string(), value: v.string() });

export default defineSchema({
  // A budget holder, keyed by (dimension, value). Unifies what used to be the
  // `users` and `actions` tables — those are just the "user" and "action"
  // dimensions now. Any tag a request carries can have its own budget here.
  buckets: defineTable({
    dimension: v.string(),
    value: v.string(),
    // limits (all optional — unlimited by default)
    requestsPerMinute: v.optional(v.number()), // enforced on the "user" dimension
    maxConcurrent: v.optional(v.number()), // max in-flight (pending) requests
    dailySpendLimitNanos: v.optional(v.number()),
    monthlySpendLimitNanos: v.optional(v.number()),
    lifetimeSpendLimitNanos: v.optional(v.number()),
    dailyTokenLimit: v.optional(v.number()),
    monthlyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    blocked: v.optional(v.boolean()), // hard block (was `blocked`/`disabled`)
    // Fire an approaching-limit alert once usage crosses this fraction of a cap
    // (e.g. 0.8 = warn at 80%). Falls back to the deployment default.
    warnAtPct: v.optional(v.number()),
    // "hard" (default): exceeding a budget blocks. "soft": warn but allow.
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
    // one-time bumps ("approve another $X"). Daily/monthly bumps are scoped to
    // their stamp (reset with the window); lifetime bump is permanent.
    dailyBumpNanos: v.optional(v.number()),
    monthlyBumpNanos: v.optional(v.number()),
    lifetimeBumpNanos: v.optional(v.number()),
    bumpDayStamp: v.optional(v.string()),
    bumpMonthStamp: v.optional(v.string()),
    // settled totals (from finished requests)
    totalSpendNanos: v.number(),
    totalRequests: v.number(),
    totalTokens: v.number(),
    // daily window
    dayStamp: v.string(),
    spendTodayNanos: v.number(),
    tokensToday: v.optional(v.number()),
    // monthly window (UTC calendar month, e.g. "2026-09")
    monthStamp: v.optional(v.string()),
    spendThisMonthNanos: v.optional(v.number()),
    tokensThisMonth: v.optional(v.number()),
    // in-flight reservations (pessimistic holds; released on settle/expiry)
    reservedTodayNanos: v.optional(v.number()),
    reservedMonthNanos: v.optional(v.number()),
    reservedTotalNanos: v.optional(v.number()),
    reservedTodayTokens: v.optional(v.number()),
    reservedMonthTokens: v.optional(v.number()),
    reservedTotalTokens: v.optional(v.number()),
    pendingCount: v.optional(v.number()),
  })
    .index("dim_value", ["dimension", "value"])
    .index("dimension", ["dimension"]),

  // Durable per-(bucket, period) spend history. Written from settled requests
  // and manual adjustments; NEVER swept by request retention, so spend charts
  // and "what did we spend last month" survive long after the raw request rows
  // are purged. period is "day" ("2026-09-04") or "month" ("2026-09").
  usage: defineTable({
    dimension: v.string(),
    value: v.string(),
    period: v.union(v.literal("day"), v.literal("month")),
    stamp: v.string(),
    spendNanos: v.number(),
    tokens: v.number(),
    requests: v.number(),
  })
    .index("bucket_period_stamp", ["dimension", "value", "period", "stamp"])
    .index("period_stamp", ["period", "stamp"]),

  // Reverse index for filtering the request log by an arbitrary tag dimension
  // (user/action are already indexed on `requests`). One row per extra tag per
  // request; cleaned up with the request on retention/deletion.
  requestTags: defineTable({
    dimension: v.string(),
    value: v.string(),
    requestId: v.id("requests"),
  })
    .index("dim_value", ["dimension", "value"])
    .index("requestId", ["requestId"]),

  // Manual credits/debits applied to a bucket (comp a user, correct an
  // overcharge). Negative delta = credit/refund, positive = extra charge.
  adjustments: defineTable({
    dimension: v.string(),
    value: v.string(),
    deltaNanos: v.number(),
    tokens: v.optional(v.number()),
    reason: v.optional(v.string()),
  }).index("dim_value", ["dimension", "value"]),

  requests: defineTable({
    // `user` and `action` stay first-class + indexed (the hot-path filters and
    // rate limiting); the full attribution incl. extra tags lives in `tags`.
    userId: v.string(),
    actionName: v.optional(v.string()),
    tags: v.optional(v.array(vTag)),
    model: v.string(),
    // pessimistic holds placed at start; reconciled to actual on settle
    estimatedNanos: v.optional(v.number()),
    estimatedTokens: v.optional(v.number()),
    // true when the model had no known/override price and was charged the
    // conservative fallback — a signal to add a real price via setPrice.
    unpricedModel: v.optional(v.boolean()),
    // true when a soft budget was exceeded (allowed with a warning).
    overBudget: v.optional(v.boolean()),
    // false once finished and awaiting fold into totals; true once folded.
    // absent while pending or blocked (so the reconciler ignores those).
    settled: v.optional(v.boolean()),
    messages: v.array(vMessage),
    status: v.union(
      v.literal("pending"),
      v.literal("success"),
      v.literal("error"),
      v.literal("blocked")
    ),
    responseText: v.optional(v.string()),
    error: v.optional(v.string()),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    // subset of promptTokens served from the provider's prompt cache (cheaper).
    cachedTokens: v.optional(v.number()),
    costNanos: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    rerunOf: v.optional(v.id("requests")),
  })
    .index("userId", ["userId"])
    .index("status", ["status"])
    .index("rerunOf", ["rerunOf"])
    .index("actionName", ["actionName"])
    .index("settled", ["settled"]),

  // per-model price overrides (nanodollars per million tokens)
  prices: defineTable({
    model: v.string(),
    inputNanosPerMTok: v.number(),
    outputNanosPerMTok: v.number(),
    // price for cached (prompt-cache-read) input tokens. Providers bill these
    // at a fraction of the input rate; if unset, a default discount is applied.
    cachedNanosPerMTok: v.optional(v.number()),
  }).index("model", ["model"]),

  // singleton component config (key === "singleton")
  settings: defineTable({
    key: v.string(),
    // "open": any model allowed. "allowlist": only listed models.
    // "denylist": any model except the listed ones.
    modelMode: v.optional(
      v.union(
        v.literal("open"),
        v.literal("allowlist"),
        v.literal("denylist")
      )
    ),
    models: v.optional(v.array(v.string())),
    // Deployment-wide ("global") spend cap across ALL requests. Running totals
    // live in a sharded counter (high write throughput) since every request
    // touches it; only the limit config lives here. Enforced approximately —
    // the sharded total is read without a reservation, so under heavy
    // concurrency it can overshoot by a bounded amount. Right for a global
    // killswitch; per-bucket caps stay exact via reserve/settle.
    globalDailySpendLimitNanos: v.optional(v.number()),
    globalLifetimeSpendLimitNanos: v.optional(v.number()),
    globalEnforcement: v.optional(
      v.union(v.literal("hard"), v.literal("soft"))
    ),
    globalDailyBumpNanos: v.optional(v.number()),
    globalLifetimeBumpNanos: v.optional(v.number()),
    globalBumpDayStamp: v.optional(v.string()),
    // request-row retention window in ms (default 1h); 0 disables sweeping.
    retentionMs: v.optional(v.number()),
    // default approaching-limit alert threshold (fraction of a cap) for buckets
    // that don't set their own warnAtPct. 0/unset disables threshold alerts.
    defaultWarnAtPct: v.optional(v.number()),
  }).index("key", ["key"]),
});
