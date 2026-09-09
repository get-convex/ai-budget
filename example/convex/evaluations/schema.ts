import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const vRunKind = v.union(
  v.literal("matrix"),
  v.literal("judge"),
  v.literal("backtest"),
  v.literal("evolve")
);

export const vRunStatus = v.union(
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("budget_exhausted")
);

export default defineSchema({
  runs: defineTable({
    kind: vRunKind,
    status: vRunStatus,
    // Configuration is deliberately opaque to the component. The application
    // adapter owns prompt/model semantics and stores a reproducible JSON snapshot.
    configJson: v.string(),
    // The corresponding AI Budget tag value is always this run's external ID.
    budgetTagDimension: v.optional(v.string()),
    summaryJson: v.optional(v.string()),
    error: v.optional(v.string()),
    completedAt: v.optional(v.number()),
  }).index("by_kind", ["kind"]),

  // Immutable inputs copied from Agent history, production traffic, or a curated
  // dataset. Evaluation never reaches into another component's private tables.
  cases: defineTable({
    runId: v.id("runs"),
    key: v.string(),
    inputJson: v.string(),
    expectedJson: v.optional(v.string()),
    sourceId: v.optional(v.string()),
  }).index("by_run", ["runId"]),

  results: defineTable({
    runId: v.id("runs"),
    caseId: v.optional(v.id("cases")),
    candidate: v.string(),
    model: v.optional(v.string()),
    outputJson: v.optional(v.string()),
    score: v.optional(v.number()),
    verdict: v.optional(v.string()),
    rationale: v.optional(v.string()),
    costNanos: v.number(),
    error: v.optional(v.string()),
  })
    .index("by_run", ["runId"])
    .index("by_case", ["caseId"]),
});
