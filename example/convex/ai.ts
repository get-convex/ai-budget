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

export const setActionLimits = mutation({
  args: {
    name: v.string(),
    dailySpendLimitCents: v.optional(v.number()),
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

export const setLimits = mutation({
  args: {
    userId: v.string(),
    requestsPerMinute: v.optional(v.number()),
    dailySpendLimitCents: v.optional(v.number()),
    blocked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ai.setLimits(ctx, args);
  },
});
