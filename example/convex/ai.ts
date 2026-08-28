// ⚠️ DEMO ONLY — no authentication. `userId` is taken from the client and the
// admin mutations (setLimits/setActionLimits/setModelPolicy/deleteUser) and the
// history queries are public. That's fine for a local demo, NOT for production.
// See the "Security: before you ship this" section of the README for the
// server-derived-identity + admin-gate + scoped-query pattern.
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { AIBudget } from "../../src/client";

const ai = new AIBudget(components.aiBudget, {
  defaultModel: "openai/gpt-4o-mini",
});

export const sendMessage = action({
  args: {
    userId: v.string(),
    prompt: v.string(),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ai.chat(ctx, args);
  },
});

export const summarize = action({
  args: { userId: v.string(), text: v.string() },
  handler: async (ctx, { userId, text }) => {
    // Attributed to the "ai:summarize" action automatically via ctx.meta.
    return await ai.chat(ctx, {
      userId,
      messages: [
        {
          role: "user",
          content: `Summarize this conversation in one short sentence:\n\n${text}`,
        },
      ],
    });
  },
});

export const rerun = action({
  args: {
    requestId: v.string(),
    messages: v.optional(
      v.array(v.object({ role: v.string(), content: v.string() }))
    ),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ai.requests.rerun(ctx, args);
  },
});

export const listRequests = query({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return await ai.requests.list(ctx, { ...args, limit: 100 });
  },
});

export const lineage = query({
  args: { requestId: v.string() },
  handler: async (ctx, args) => {
    return await ai.requests.lineage(ctx, args);
  },
});

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    return await ai.users.list(ctx);
  },
});

export const listPrices = query({
  args: {},
  handler: async (ctx) => {
    return await ai.prices.list(ctx);
  },
});

export const listActions = query({
  args: {},
  handler: async (ctx) => {
    return await ai.actions.list(ctx);
  },
});

export const setPrice = mutation({
  args: {
    model: v.string(),
    inputNanosPerMTok: v.number(),
    outputNanosPerMTok: v.number(),
  },
  handler: async (ctx, args) => {
    await ai.prices.set(ctx, args);
  },
});

export const getModelPolicy = query({
  args: {},
  handler: async (ctx) => {
    return await ai.models.getPolicy(ctx);
  },
});

export const getGlobalStatus = query({
  args: {},
  handler: async (ctx) => {
    return await ai.global.status(ctx);
  },
});

export const setGlobalLimits = mutation({
  args: {
    dailySpendLimitNanos: v.optional(v.number()),
    lifetimeSpendLimitNanos: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
  },
  handler: async (ctx, args) => {
    await ai.global.setLimits(ctx, args);
  },
});

export const setModelPolicy = mutation({
  args: {
    mode: v.union(
      v.literal("open"),
      v.literal("allowlist"),
      v.literal("denylist")
    ),
    models: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ai.models.setPolicy(ctx, args);
  },
});

export const setActionLimits = mutation({
  args: {
    name: v.string(),
    dailySpendLimitNanos: v.optional(v.number()),
    lifetimeSpendLimitNanos: v.optional(v.number()),
    dailyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
    disabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ai.actions.setLimits(ctx, args);
  },
});

export const deleteUser = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ai.users.delete(ctx, args);
  },
});

export const bumpUser = mutation({
  args: {
    userId: v.string(),
    dailyNanos: v.optional(v.number()),
    lifetimeNanos: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ai.users.bump(ctx, args);
  },
});

export const bumpAction = mutation({
  args: {
    name: v.string(),
    dailyNanos: v.optional(v.number()),
    lifetimeNanos: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ai.actions.bump(ctx, args);
  },
});

export const bumpGlobal = mutation({
  args: {
    dailyNanos: v.optional(v.number()),
    lifetimeNanos: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ai.global.bump(ctx, args);
  },
});

export const setLimits = mutation({
  args: {
    userId: v.string(),
    requestsPerMinute: v.optional(v.number()),
    dailySpendLimitNanos: v.optional(v.number()),
    lifetimeSpendLimitNanos: v.optional(v.number()),
    dailyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
    blocked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ai.users.setLimits(ctx, args);
  },
});
