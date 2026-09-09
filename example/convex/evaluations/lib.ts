import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { vRunKind, vRunStatus } from "./schema";

const vRun = v.object({
  _id: v.id("runs"),
  _creationTime: v.number(),
  kind: vRunKind,
  status: vRunStatus,
  configJson: v.string(),
  budgetTagDimension: v.optional(v.string()),
  summaryJson: v.optional(v.string()),
  error: v.optional(v.string()),
  completedAt: v.optional(v.number()),
});

const vCase = v.object({
  _id: v.id("cases"),
  _creationTime: v.number(),
  runId: v.id("runs"),
  key: v.string(),
  inputJson: v.string(),
  expectedJson: v.optional(v.string()),
  sourceId: v.optional(v.string()),
});

const vResult = v.object({
  _id: v.id("results"),
  _creationTime: v.number(),
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
});

function boundedLimit(value: number | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error("limit must be finite");
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

export const createRun = mutation({
  args: {
    kind: vRunKind,
    configJson: v.string(),
    budgetTagDimension: v.optional(v.string()),
  },
  returns: v.id("runs"),
  handler: async (ctx, args) =>
    ctx.db.insert("runs", { ...args, status: "running" }),
});

export const addCase = mutation({
  args: {
    runId: v.id("runs"),
    key: v.string(),
    inputJson: v.string(),
    expectedJson: v.optional(v.string()),
    sourceId: v.optional(v.string()),
  },
  returns: v.id("cases"),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") throw new Error("Run is not active");
    return ctx.db.insert("cases", args);
  },
});

export const recordResult = mutation({
  args: {
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
  },
  returns: v.id("results"),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "running") throw new Error("Run is not active");
    if (args.caseId !== undefined) {
      const testCase = await ctx.db.get(args.caseId);
      if (!testCase || testCase.runId !== args.runId)
        throw new Error("Case does not belong to run");
    }
    if (!Number.isFinite(args.costNanos) || args.costNanos < 0)
      throw new Error("costNanos must be finite and non-negative");
    if (args.score !== undefined && !Number.isFinite(args.score))
      throw new Error("score must be finite");
    return ctx.db.insert("results", args);
  },
});

export const completeRun = mutation({
  args: {
    runId: v.id("runs"),
    status: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("budget_exhausted")
    ),
    summaryJson: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { runId, status, summaryJson, error }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Unknown run");
    if (run.status !== "running") return null;
    await ctx.db.patch(runId, {
      status,
      summaryJson,
      error,
      completedAt: Date.now(),
    });
    return null;
  },
});

export const getRun = query({
  args: { runId: v.id("runs") },
  returns: v.union(vRun, v.null()),
  handler: async (ctx, { runId }) => ctx.db.get(runId),
});

export const listRuns = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(vRun),
  handler: async (ctx, { limit }) =>
    ctx.db
      .query("runs")
      .order("desc")
      .take(boundedLimit(limit, 50, 100)),
});

export const listCases = query({
  args: { runId: v.id("runs"), limit: v.optional(v.number()) },
  returns: v.array(vCase),
  handler: async (ctx, { runId, limit }) =>
    ctx.db
      .query("cases")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(boundedLimit(limit, 100, 500)),
});

export const listResults = query({
  args: { runId: v.id("runs"), limit: v.optional(v.number()) },
  returns: v.array(vResult),
  handler: async (ctx, { runId, limit }) =>
    ctx.db
      .query("results")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(boundedLimit(limit, 100, 500)),
});
