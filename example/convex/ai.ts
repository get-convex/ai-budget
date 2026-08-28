// ⚠️ DEMO ONLY — no authentication. `userId` is taken from the client and the
// admin mutations (setLimits/setActionLimits/setModelPolicy/deleteUser) and the
// history queries are public. That's fine for a local demo, NOT for production.
// See the "Security: before you ship this" section of the README for the
// server-derived-identity + admin-gate + scoped-query pattern.
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { WorryFreeAI } from "../../src/client";

const ai = new WorryFreeAI(components.aiBudget, {
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
    return await ai.rerun(ctx, args);
  },
});

export const listRequests = query({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return await ai.listRequests(ctx, { ...args, limit: 100 });
  },
});

export const lineage = query({
  args: { requestId: v.string() },
  handler: async (ctx, args) => {
    return await ai.lineage(ctx, args);
  },
});

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    return await ai.listUsers(ctx);
  },
});

export const listPrices = query({
  args: {},
  handler: async (ctx) => {
    return await ai.listPrices(ctx);
  },
});

export const listActions = query({
  args: {},
  handler: async (ctx) => {
    return await ai.listActions(ctx);
  },
});

export const setPrice = mutation({
  args: {
    model: v.string(),
    inputCentsPerMTok: v.number(),
    outputCentsPerMTok: v.number(),
  },
  handler: async (ctx, args) => {
    await ai.setPrice(ctx, args);
  },
});

export const getModelPolicy = query({
  args: {},
  handler: async (ctx) => {
    return await ai.getModelPolicy(ctx);
  },
});

export const getGlobalStatus = query({
  args: {},
  handler: async (ctx) => {
    return await ai.getGlobalStatus(ctx);
  },
});

export const setGlobalLimits = mutation({
  args: {
    dailySpendLimitCents: v.optional(v.number()),
    lifetimeSpendLimitCents: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
  },
  handler: async (ctx, args) => {
    await ai.setGlobalLimits(ctx, args);
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
    await ai.setModelPolicy(ctx, args);
  },
});

export const setActionLimits = mutation({
  args: {
    name: v.string(),
    dailySpendLimitCents: v.optional(v.number()),
    lifetimeSpendLimitCents: v.optional(v.number()),
    dailyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
    disabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ai.setActionLimits(ctx, args);
  },
});

export const deleteUser = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ai.deleteUser(ctx, args);
  },
});

export const bumpUser = mutation({
  args: {
    userId: v.string(),
    dailyCents: v.optional(v.number()),
    lifetimeCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ai.bumpUser(ctx, args);
  },
});

export const bumpAction = mutation({
  args: {
    name: v.string(),
    dailyCents: v.optional(v.number()),
    lifetimeCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ai.bumpAction(ctx, args);
  },
});

export const bumpGlobal = mutation({
  args: {
    dailyCents: v.optional(v.number()),
    lifetimeCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ai.bumpGlobal(ctx, args);
  },
});

export const setLimits = mutation({
  args: {
    userId: v.string(),
    requestsPerMinute: v.optional(v.number()),
    dailySpendLimitCents: v.optional(v.number()),
    lifetimeSpendLimitCents: v.optional(v.number()),
    dailyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
    blocked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ai.setLimits(ctx, args);
  },
});
