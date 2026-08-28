import { v } from "convex/values";
import {
  mutation,
  internalMutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { vMessage } from "./schema";
import type { Doc } from "./_generated/dataModel";

// Fallback prices in cents per million tokens, used when no override is stored.
const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4.5": { input: 300, output: 1500 },
  "anthropic/claude-haiku-4.5": { input: 100, output: 500 },
  "openai/gpt-4o": { input: 250, output: 1000 },
  "openai/gpt-4o-mini": { input: 15, output: 60 },
  "openai/gpt-5": { input: 125, output: 1000 },
  "openai/gpt-5-mini": { input: 25, output: 200 },
};

// Pessimistic assumed output length when reserving budget up front. Reservations
// only need to be an upper bound often enough to keep a hard cap honest; the
// actual cost replaces the estimate the moment the request settles.
const ESTIMATED_OUTPUT_TOKENS = 800;
// A request still "pending" after this long is presumed dead (its action
// crashed before settling); the reconciler releases its reservation.
const STALE_PENDING_MS = 5 * 60 * 1000;

const dayStamp = () => new Date().toISOString().slice(0, 10);

async function getPrice(ctx: MutationCtx, model: string) {
  const override = await ctx.db
    .query("prices")
    .withIndex("model", (q) => q.eq("model", model))
    .unique();
  return override
    ? { input: override.inputCentsPerMTok, output: override.outputCentsPerMTok }
    : DEFAULT_PRICES[model] ?? { input: 0, output: 0 };
}

const costOf = (
  inputTokens: number,
  outputTokens: number,
  price: { input: number; output: number }
) => (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;

function estimateCost(
  messages: { content: string }[],
  price: { input: number; output: number }
) {
  const chars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  return costOf(Math.ceil(chars / 4), ESTIMATED_OUTPUT_TOKENS, price);
}

async function getOrCreateUser(ctx: MutationCtx, userId: string) {
  const existing = await ctx.db
    .query("users")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .unique();
  if (existing) return existing;
  const id = await ctx.db.insert("users", {
    userId,
    totalSpendCents: 0,
    totalRequests: 0,
    totalTokens: 0,
    dayStamp: dayStamp(),
    spendTodayCents: 0,
  });
  return (await ctx.db.get(id))!;
}

async function getOrCreateAction(ctx: MutationCtx, name: string) {
  const existing = await ctx.db
    .query("actions")
    .withIndex("name", (q) => q.eq("name", name))
    .unique();
  if (existing) return existing;
  const id = await ctx.db.insert("actions", {
    name,
    totalSpendCents: 0,
    totalRequests: 0,
    totalTokens: 0,
    dayStamp: dayStamp(),
    spendTodayCents: 0,
  });
  return (await ctx.db.get(id))!;
}

const vStartResult = v.union(
  v.object({ allowed: v.literal(true), requestId: v.id("requests") }),
  v.object({
    allowed: v.literal(false),
    code: v.string(),
    reason: v.string(),
  })
);

export const startRequest = mutation({
  args: {
    userId: v.string(),
    actionName: v.optional(v.string()),
    model: v.string(),
    messages: v.array(vMessage),
    rerunOf: v.optional(v.id("requests")),
  },
  returns: vStartResult,
  handler: async (ctx, args) => {
    const user = await getOrCreateUser(ctx, args.userId);
    // Record the blocked attempt and return a rejection (throwing would roll
    // back the record).
    const reject = async (code: string, reason: string) => {
      await ctx.db.insert("requests", {
        ...args,
        status: "blocked" as const,
        error: reason,
      });
      return { allowed: false as const, code, reason };
    };

    const today = dayStamp();
    // Cost this request could incur, reserved up front so concurrent in-flight
    // requests are visible to each other's limit checks.
    const estimate = estimateCost(args.messages, await getPrice(ctx, args.model));

    if (user.blocked) {
      return reject("blocked", `User "${args.userId}" is blocked`);
    }
    if (user.requestsPerMinute !== undefined) {
      const recent = await ctx.db
        .query("requests")
        .withIndex("userId", (q) =>
          q.eq("userId", args.userId).gt("_creationTime", Date.now() - 60_000)
        )
        .collect();
      if (recent.filter((r) => r.status !== "blocked").length >= user.requestsPerMinute) {
        return reject(
          "rate_limit",
          `Rate limit exceeded for "${args.userId}" (${user.requestsPerMinute}/min)`
        );
      }
    }
    // Committed spend + already-reserved in-flight spend + this estimate must
    // fit under the cap. This is decided and reserved in one transaction, so
    // Convex's serializable isolation makes it a true atomic check-and-reserve.
    const userSameDay = user.dayStamp === today;
    const userSpendToday = userSameDay ? user.spendTodayCents : 0;
    const userReservedToday = userSameDay ? user.reservedTodayCents ?? 0 : 0;
    const userReservedTotal = user.reservedTotalCents ?? 0;
    if (
      user.dailySpendLimitCents !== undefined &&
      userSpendToday + userReservedToday + estimate > user.dailySpendLimitCents
    ) {
      return reject(
        "daily_spend_limit",
        `Daily spend limit reached for "${args.userId}" (${user.dailySpendLimitCents}¢/day)`
      );
    }
    if (
      user.lifetimeSpendLimitCents !== undefined &&
      user.totalSpendCents + userReservedTotal + estimate >
        user.lifetimeSpendLimitCents
    ) {
      return reject(
        "lifetime_spend_limit",
        `Lifetime spend limit reached for "${args.userId}"`
      );
    }

    let action: Doc<"actions"> | null = null;
    if (args.actionName !== undefined) {
      action = await getOrCreateAction(ctx, args.actionName);
      if (action.disabled) {
        return reject("action_disabled", `Action "${action.name}" is disabled`);
      }
      const aSameDay = action.dayStamp === today;
      const aSpendToday = aSameDay ? action.spendTodayCents : 0;
      const aReservedToday = aSameDay ? action.reservedTodayCents ?? 0 : 0;
      const aReservedTotal = action.reservedTotalCents ?? 0;
      if (
        action.dailySpendLimitCents !== undefined &&
        aSpendToday + aReservedToday + estimate > action.dailySpendLimitCents
      ) {
        return reject(
          "action_daily_spend_limit",
          `Daily spend limit reached for action "${action.name}" (${action.dailySpendLimitCents}¢/day)`
        );
      }
      if (
        action.lifetimeSpendLimitCents !== undefined &&
        action.totalSpendCents + aReservedTotal + estimate >
          action.lifetimeSpendLimitCents
      ) {
        return reject(
          "action_lifetime_spend_limit",
          `Lifetime spend limit reached for action "${action.name}"`
        );
      }
    }

    // Passed — reserve, but ONLY on entities that actually have a spend cap.
    // Writing an uncapped entity's row here would serialize every request that
    // shares it (e.g. all callers of one action), so we skip it: with no cap
    // there is no reserved amount to consult. Totals are still accrued later,
    // asynchronously, in foldOne.
    const userHasSpendCap =
      user.dailySpendLimitCents !== undefined ||
      user.lifetimeSpendLimitCents !== undefined;
    if (userHasSpendCap) {
      await ctx.db.patch(user._id, {
        dayStamp: today,
        spendTodayCents: userSpendToday,
        reservedTodayCents: userReservedToday + estimate,
        reservedTotalCents: userReservedTotal + estimate,
        pendingCount: (user.pendingCount ?? 0) + 1,
      });
    }
    if (
      action &&
      (action.dailySpendLimitCents !== undefined ||
        action.lifetimeSpendLimitCents !== undefined)
    ) {
      const aSameDay = action.dayStamp === today;
      await ctx.db.patch(action._id, {
        dayStamp: today,
        spendTodayCents: aSameDay ? action.spendTodayCents : 0,
        reservedTodayCents:
          (aSameDay ? action.reservedTodayCents ?? 0 : 0) + estimate,
        reservedTotalCents: (action.reservedTotalCents ?? 0) + estimate,
        pendingCount: (action.pendingCount ?? 0) + 1,
      });
    }
    const requestId = await ctx.db.insert("requests", {
      ...args,
      status: "pending",
      estimatedCents: estimate,
    });
    return { allowed: true as const, requestId };
  },
});

export const finishRequest = mutation({
  args: {
    requestId: v.id("requests"),
    responseText: v.optional(v.string()),
    error: v.optional(v.string()),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
  },
  returns: v.object({ costCents: v.number() }),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request) throw new Error("Unknown request");

    // Clamp caller-supplied token counts: negatives would produce negative cost
    // and could refund a user below their cap.
    const promptTokens = Math.max(0, args.promptTokens ?? 0);
    const completionTokens = Math.max(0, args.completionTokens ?? 0);
    const costCents = costOf(
      promptTokens,
      completionTokens,
      await getPrice(ctx, request.model)
    );

    // Durable write to the request's OWN row only — uncontended, so it always
    // lands. `settled: false` hands it to the fold step; the row is never left
    // orphaned in "pending" even if the totals update below fails and retries.
    await ctx.db.patch(args.requestId, {
      status: args.error ? "error" : "success",
      responseText: args.responseText,
      error: args.error,
      promptTokens,
      completionTokens,
      costCents,
      latencyMs: args.latencyMs,
      settled: false,
    });

    // Fold into the (hot) user/action counters in a separate mutation. If it
    // exhausts retries under contention, the cron reconciler picks it up.
    await ctx.scheduler.runAfter(0, internal.lib.foldTotals, {
      requestId: args.requestId,
    });
    return { costCents };
  },
});

// Fold one finished request into the user/action running totals, releasing its
// reservation. Idempotent: guarded by `settled` so the scheduler and the cron
// reconciler can never double-count.
async function foldOne(ctx: MutationCtx, req: Doc<"requests"> | null) {
  if (!req || req.settled !== false) return;
  const actual = req.costCents ?? 0;
  const estimate = req.estimatedCents ?? 0;
  const tokens = (req.promptTokens ?? 0) + (req.completionTokens ?? 0);
  const today = dayStamp();

  const user = await getOrCreateUser(ctx, req.userId);
  const uSameDay = user.dayStamp === today;
  await ctx.db.patch(user._id, {
    totalSpendCents: user.totalSpendCents + actual,
    totalRequests: user.totalRequests + 1,
    totalTokens: user.totalTokens + tokens,
    dayStamp: today,
    spendTodayCents: (uSameDay ? user.spendTodayCents : 0) + actual,
    reservedTodayCents: Math.max(
      0,
      (uSameDay ? user.reservedTodayCents ?? 0 : 0) - estimate
    ),
    reservedTotalCents: Math.max(0, (user.reservedTotalCents ?? 0) - estimate),
    pendingCount: Math.max(0, (user.pendingCount ?? 0) - 1),
  });

  if (req.actionName !== undefined) {
    const action = await getOrCreateAction(ctx, req.actionName);
    const aSameDay = action.dayStamp === today;
    await ctx.db.patch(action._id, {
      totalSpendCents: action.totalSpendCents + actual,
      totalRequests: action.totalRequests + 1,
      totalTokens: action.totalTokens + tokens,
      dayStamp: today,
      spendTodayCents: (aSameDay ? action.spendTodayCents : 0) + actual,
      reservedTodayCents: Math.max(
        0,
        (aSameDay ? action.reservedTodayCents ?? 0 : 0) - estimate
      ),
      reservedTotalCents: Math.max(
        0,
        (action.reservedTotalCents ?? 0) - estimate
      ),
      pendingCount: Math.max(0, (action.pendingCount ?? 0) - 1),
    });
  }
  await ctx.db.patch(req._id, { settled: true });
}

export const foldTotals = internalMutation({
  args: { requestId: v.id("requests") },
  returns: v.null(),
  handler: async (ctx, { requestId }) => {
    await foldOne(ctx, await ctx.db.get(requestId));
    return null;
  },
});

// Backstop for both failure modes: folds finished requests whose scheduled fold
// lost the retry race, and releases reservations for requests that never
// settled (their action crashed). Runs on a cron.
export const reconcile = internalMutation({
  args: {},
  returns: v.object({ folded: v.number(), expired: v.number() }),
  handler: async (ctx) => {
    const toFold = await ctx.db
      .query("requests")
      .withIndex("settled", (q) => q.eq("settled", false))
      .take(200);
    for (const req of toFold) await foldOne(ctx, req);

    const cutoff = Date.now() - STALE_PENDING_MS;
    const stale = await ctx.db
      .query("requests")
      .withIndex("status", (q) => q.eq("status", "pending"))
      .filter((q) => q.lt(q.field("_creationTime"), cutoff))
      .take(200);
    for (const req of stale) {
      await ctx.db.patch(req._id, {
        status: "error",
        error: "Timed out before settling; reservation released",
        costCents: 0,
        settled: false,
      });
      await foldOne(ctx, await ctx.db.get(req._id));
    }
    return { folded: toFold.length, expired: stale.length };
  },
});

export const lineage = query({
  args: { requestId: v.id("requests") },
  handler: async (ctx, { requestId }) => {
    // Walk up to the root of the re-run chain.
    const ancestors = [];
    let cursor = await ctx.db.get(requestId);
    while (cursor?.rerunOf) {
      const parent = await ctx.db.get(cursor.rerunOf);
      if (!parent) break;
      ancestors.unshift(parent);
      cursor = parent;
    }
    const reruns = await ctx.db
      .query("requests")
      .withIndex("rerunOf", (q) => q.eq("rerunOf", requestId))
      .collect();
    return { ancestors, reruns };
  },
});

export const getRequest = query({
  args: { requestId: v.id("requests") },
  handler: async (ctx, args) => ctx.db.get(args.requestId),
});

export const listRequests = query({
  args: { userId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    if (args.userId !== undefined) {
      const userId = args.userId;
      return await ctx.db
        .query("requests")
        .withIndex("userId", (q) => q.eq("userId", userId))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("requests").order("desc").take(limit);
  },
});

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const today = dayStamp();
    return users.map((u) => ({
      ...u,
      spendTodayCents: u.dayStamp === today ? u.spendTodayCents : 0,
    }));
  },
});

export const setLimits = mutation({
  args: {
    userId: v.string(),
    requestsPerMinute: v.optional(v.number()),
    dailySpendLimitCents: v.optional(v.number()),
    lifetimeSpendLimitCents: v.optional(v.number()),
    blocked: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await getOrCreateUser(ctx, args.userId);
    const { userId: _userId, ...limits } = args;
    await ctx.db.patch(user._id, limits);
    return null;
  },
});

// Delete a user and all their request rows (e.g. account deletion / GDPR).
export const deleteUser = mutation({
  args: { userId: v.string() },
  returns: v.number(),
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("requests")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    const user = await ctx.db
      .query("users")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .unique();
    if (user) await ctx.db.delete(user._id);
    return rows.length + (user ? 1 : 0);
  },
});

export const listActions = query({
  args: {},
  handler: async (ctx) => {
    const actions = await ctx.db.query("actions").collect();
    const today = dayStamp();
    return actions.map((a) => ({
      ...a,
      spendTodayCents: a.dayStamp === today ? a.spendTodayCents : 0,
    }));
  },
});

export const setActionLimits = mutation({
  args: {
    name: v.string(),
    dailySpendLimitCents: v.optional(v.number()),
    lifetimeSpendLimitCents: v.optional(v.number()),
    disabled: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const action = await getOrCreateAction(ctx, args.name);
    const { name: _name, ...limits } = args;
    await ctx.db.patch(action._id, limits);
    return null;
  },
});

export const setPrice = mutation({
  args: {
    model: v.string(),
    inputCentsPerMTok: v.number(),
    outputCentsPerMTok: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("prices")
      .withIndex("model", (q) => q.eq("model", args.model))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("prices", args);
    }
    return null;
  },
});

export const listPrices = query({
  args: {},
  handler: async (ctx) => {
    const overrides = await ctx.db.query("prices").collect();
    const merged: Record<string, { input: number; output: number; overridden: boolean }> = {};
    for (const [model, p] of Object.entries(DEFAULT_PRICES)) {
      merged[model] = { ...p, overridden: false };
    }
    for (const o of overrides) {
      merged[o.model] = {
        input: o.inputCentsPerMTok,
        output: o.outputCentsPerMTok,
        overridden: true,
      };
    }
    return merged;
  },
});
