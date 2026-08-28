import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const vMessage = v.object({
  role: v.string(), // "system" | "user" | "assistant" | "tool"
  content: v.string(),
});

export default defineSchema({
  users: defineTable({
    userId: v.string(), // app-provided stable key (your user id)
    // limits (all optional — unlimited by default)
    requestsPerMinute: v.optional(v.number()),
    dailySpendLimitCents: v.optional(v.number()),
    lifetimeSpendLimitCents: v.optional(v.number()),
    blocked: v.optional(v.boolean()),
    // settled totals (from finished requests)
    totalSpendCents: v.number(),
    totalRequests: v.number(),
    totalTokens: v.number(),
    // daily window
    dayStamp: v.string(), // e.g. "2026-08-27" (UTC)
    spendTodayCents: v.number(),
    // in-flight reservations (pessimistic holds; released on settle/expiry)
    reservedTodayCents: v.optional(v.number()),
    reservedTotalCents: v.optional(v.number()),
    pendingCount: v.optional(v.number()),
  }).index("userId", ["userId"]),

  // per-action-name budgets and running totals (e.g. "chat", "summarize")
  actions: defineTable({
    name: v.string(),
    dailySpendLimitCents: v.optional(v.number()),
    lifetimeSpendLimitCents: v.optional(v.number()),
    disabled: v.optional(v.boolean()),
    totalSpendCents: v.number(),
    totalRequests: v.number(),
    totalTokens: v.number(),
    dayStamp: v.string(),
    spendTodayCents: v.number(),
    reservedTodayCents: v.optional(v.number()),
    reservedTotalCents: v.optional(v.number()),
    pendingCount: v.optional(v.number()),
  }).index("name", ["name"]),

  requests: defineTable({
    userId: v.string(),
    actionName: v.optional(v.string()),
    model: v.string(),
    // pessimistic hold placed at start; reconciled to actual on settle
    estimatedCents: v.optional(v.number()),
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
    costCents: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    rerunOf: v.optional(v.id("requests")),
  })
    .index("userId", ["userId"])
    .index("status", ["status"])
    .index("rerunOf", ["rerunOf"])
    .index("actionName", ["actionName"])
    .index("settled", ["settled"]),

  // per-model price overrides (cents per million tokens)
  prices: defineTable({
    model: v.string(),
    inputCentsPerMTok: v.number(),
    outputCentsPerMTok: v.number(),
  }).index("model", ["model"]),
});
