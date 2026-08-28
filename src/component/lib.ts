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
// crashed before settling); the reconciler releases its reservation. Set well
// above any real call duration — a long reasoning/agent generation that is
// still billing must not be swept and mis-recorded as free. A late
// finishRequest is a no-op once swept (see finishRequest's terminal guard), so
// the only cost of a generous timeout is a briefly-held reservation.
const STALE_PENDING_MS = 30 * 60 * 1000;

const dayStamp = () => new Date().toISOString().slice(0, 10);

// Conservative fallback for any model not in the price table: the max of every
// known price dimension. Falling back to 0 would be fail-open — an unpriced
// model would reserve 0, pass every cap, and log 0¢ while the AI Gateway still
// bills real money. Charging the conservative max instead keeps the caps honest
// (over-counting is the safe direction); admins can pin an exact price via
// setPrice, which also clears the `unpricedModel` flag on future requests.
const CONSERVATIVE_PRICE = Object.values(DEFAULT_PRICES).reduce(
  (m, p) => ({
    input: Math.max(m.input, p.input),
    output: Math.max(m.output, p.output),
  }),
  { input: 0, output: 0 }
);

async function getPrice(ctx: MutationCtx, model: string) {
  const override = await ctx.db
    .query("prices")
    .withIndex("model", (q) => q.eq("model", model))
    .unique();
  if (override) {
    return {
      input: override.inputCentsPerMTok,
      output: override.outputCentsPerMTok,
      known: true,
    };
  }
  const known = DEFAULT_PRICES[model];
  if (known) return { ...known, known: true };
  return { ...CONSERVATIVE_PRICE, known: false };
}

const costOf = (
  inputTokens: number,
  outputTokens: number,
  price: { input: number; output: number }
) => (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;

// Up-front estimate of a request's cost and token count, reserved before the
// call so concurrent in-flight requests are visible to each other's caps.
function estimateUsage(
  messages: { content: string }[],
  price: { input: number; output: number }
) {
  const chars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  const inputTokens = Math.ceil(chars / 4);
  return {
    cost: costOf(inputTokens, ESTIMATED_OUTPUT_TOKENS, price),
    tokens: inputTokens + ESTIMATED_OUTPUT_TOKENS,
  };
}

// Evaluate an entity's (user or action) spend + token budgets against
// committed + reserved + this request's estimate. Returns a hard rejection
// (block) or a list of soft warnings (allow), per the entity's enforcement.
function evaluateCaps(o: {
  label: string;
  name: string;
  enforcement: "hard" | "soft";
  estCost: number;
  estTokens: number;
  spendToday: number;
  reservedSpendToday: number;
  totalSpend: number;
  reservedSpendTotal: number;
  tokensToday: number;
  reservedTokensToday: number;
  totalTokens: number;
  reservedTokensTotal: number;
  dailySpendLimitCents?: number;
  lifetimeSpendLimitCents?: number;
  dailyTokenLimit?: number;
  lifetimeTokenLimit?: number;
}): { hard?: { code: string; reason: string }; warnings: string[] } {
  const violations: { code: string; reason: string }[] = [];
  const push = (code: string, reason: string) =>
    violations.push({ code: `${o.label}_${code}`, reason });

  if (
    o.dailySpendLimitCents !== undefined &&
    o.spendToday + o.reservedSpendToday + o.estCost > o.dailySpendLimitCents
  )
    push("daily_spend_limit", `Daily spend limit reached for ${o.label} "${o.name}" (${o.dailySpendLimitCents}¢/day)`);
  if (
    o.lifetimeSpendLimitCents !== undefined &&
    o.totalSpend + o.reservedSpendTotal + o.estCost > o.lifetimeSpendLimitCents
  )
    push("lifetime_spend_limit", `Lifetime spend limit reached for ${o.label} "${o.name}"`);
  if (
    o.dailyTokenLimit !== undefined &&
    o.tokensToday + o.reservedTokensToday + o.estTokens > o.dailyTokenLimit
  )
    push("daily_token_limit", `Daily token limit reached for ${o.label} "${o.name}" (${o.dailyTokenLimit}/day)`);
  if (
    o.lifetimeTokenLimit !== undefined &&
    o.totalTokens + o.reservedTokensTotal + o.estTokens > o.lifetimeTokenLimit
  )
    push("lifetime_token_limit", `Lifetime token limit reached for ${o.label} "${o.name}"`);

  if (violations.length === 0) return { warnings: [] };
  if (o.enforcement === "soft") return { warnings: violations.map((v) => v.reason) };
  return { hard: violations[0], warnings: [] };
}

const hasAnyCap = (e: {
  dailySpendLimitCents?: number;
  lifetimeSpendLimitCents?: number;
  dailyTokenLimit?: number;
  lifetimeTokenLimit?: number;
}) =>
  e.dailySpendLimitCents !== undefined ||
  e.lifetimeSpendLimitCents !== undefined ||
  e.dailyTokenLimit !== undefined ||
  e.lifetimeTokenLimit !== undefined;

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

async function getSettings(ctx: MutationCtx) {
  return await ctx.db
    .query("settings")
    .withIndex("key", (q) => q.eq("key", "singleton"))
    .unique();
}

const vStartResult = v.union(
  v.object({
    allowed: v.literal(true),
    requestId: v.id("requests"),
    warnings: v.array(v.string()),
  }),
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
    const priceInfo = await getPrice(ctx, args.model);
    const est = estimateUsage(args.messages, priceInfo);
    const warnings: string[] = [];

    if (user.blocked) {
      return reject("blocked", `User "${args.userId}" is blocked`);
    }
    // Model allow/deny policy (component-wide).
    const policy = await getSettings(ctx);
    if (policy) {
      const mode = policy.modelMode ?? "open";
      const list = policy.models ?? [];
      if (mode === "allowlist" && !list.includes(args.model)) {
        return reject(
          "model_not_allowed",
          `Model "${args.model}" is not on the allowlist`
        );
      }
      if (mode === "denylist" && list.includes(args.model)) {
        return reject("model_denied", `Model "${args.model}" is denied`);
      }
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
    // Committed + already-reserved in-flight usage + this estimate must fit
    // under each cap. Decided and reserved in one transaction, so Convex's
    // serializable isolation makes it a true atomic check-and-reserve. Soft
    // enforcement turns a violation into a warning instead of a block.
    const userSameDay = user.dayStamp === today;
    const userEval = evaluateCaps({
      label: "user",
      name: args.userId,
      enforcement: user.enforcement ?? "hard",
      estCost: est.cost,
      estTokens: est.tokens,
      spendToday: userSameDay ? user.spendTodayCents : 0,
      reservedSpendToday: userSameDay ? user.reservedTodayCents ?? 0 : 0,
      totalSpend: user.totalSpendCents,
      reservedSpendTotal: user.reservedTotalCents ?? 0,
      tokensToday: userSameDay ? user.tokensToday ?? 0 : 0,
      reservedTokensToday: userSameDay ? user.reservedTodayTokens ?? 0 : 0,
      totalTokens: user.totalTokens,
      reservedTokensTotal: user.reservedTotalTokens ?? 0,
      dailySpendLimitCents: user.dailySpendLimitCents,
      lifetimeSpendLimitCents: user.lifetimeSpendLimitCents,
      dailyTokenLimit: user.dailyTokenLimit,
      lifetimeTokenLimit: user.lifetimeTokenLimit,
    });
    if (userEval.hard) return reject(userEval.hard.code, userEval.hard.reason);
    warnings.push(...userEval.warnings);

    let action: Doc<"actions"> | null = null;
    if (args.actionName !== undefined) {
      action = await getOrCreateAction(ctx, args.actionName);
      if (action.disabled) {
        return reject("action_disabled", `Action "${action.name}" is disabled`);
      }
      const aSameDay = action.dayStamp === today;
      const actionEval = evaluateCaps({
        label: "action",
        name: action.name,
        enforcement: action.enforcement ?? "hard",
        estCost: est.cost,
        estTokens: est.tokens,
        spendToday: aSameDay ? action.spendTodayCents : 0,
        reservedSpendToday: aSameDay ? action.reservedTodayCents ?? 0 : 0,
        totalSpend: action.totalSpendCents,
        reservedSpendTotal: action.reservedTotalCents ?? 0,
        tokensToday: aSameDay ? action.tokensToday ?? 0 : 0,
        reservedTokensToday: aSameDay ? action.reservedTodayTokens ?? 0 : 0,
        totalTokens: action.totalTokens,
        reservedTokensTotal: action.reservedTotalTokens ?? 0,
        dailySpendLimitCents: action.dailySpendLimitCents,
        lifetimeSpendLimitCents: action.lifetimeSpendLimitCents,
        dailyTokenLimit: action.dailyTokenLimit,
        lifetimeTokenLimit: action.lifetimeTokenLimit,
      });
      if (actionEval.hard) return reject(actionEval.hard.code, actionEval.hard.reason);
      warnings.push(...actionEval.warnings);
    }

    // Passed — reserve, but ONLY on entities that actually have a cap. Writing
    // an uncapped entity's row here would serialize every request that shares it
    // (e.g. all callers of one action); with no cap there's no reserved amount
    // to consult. Totals are still accrued later, asynchronously, in foldOne.
    if (hasAnyCap(user)) {
      await ctx.db.patch(user._id, {
        dayStamp: today,
        spendTodayCents: userSameDay ? user.spendTodayCents : 0,
        tokensToday: userSameDay ? user.tokensToday ?? 0 : 0,
        reservedTodayCents: (userSameDay ? user.reservedTodayCents ?? 0 : 0) + est.cost,
        reservedTotalCents: (user.reservedTotalCents ?? 0) + est.cost,
        reservedTodayTokens: (userSameDay ? user.reservedTodayTokens ?? 0 : 0) + est.tokens,
        reservedTotalTokens: (user.reservedTotalTokens ?? 0) + est.tokens,
        pendingCount: (user.pendingCount ?? 0) + 1,
      });
    }
    if (action && hasAnyCap(action)) {
      const aSameDay = action.dayStamp === today;
      await ctx.db.patch(action._id, {
        dayStamp: today,
        spendTodayCents: aSameDay ? action.spendTodayCents : 0,
        tokensToday: aSameDay ? action.tokensToday ?? 0 : 0,
        reservedTodayCents: (aSameDay ? action.reservedTodayCents ?? 0 : 0) + est.cost,
        reservedTotalCents: (action.reservedTotalCents ?? 0) + est.cost,
        reservedTodayTokens: (aSameDay ? action.reservedTodayTokens ?? 0 : 0) + est.tokens,
        reservedTotalTokens: (action.reservedTotalTokens ?? 0) + est.tokens,
        pendingCount: (action.pendingCount ?? 0) + 1,
      });
    }
    const requestId = await ctx.db.insert("requests", {
      ...args,
      status: "pending",
      estimatedCents: est.cost,
      estimatedTokens: est.tokens,
      ...(priceInfo.known ? {} : { unpricedModel: true }),
      ...(warnings.length > 0 ? { overBudget: true } : {}),
    });
    return { allowed: true as const, requestId, warnings };
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

    // Exactly-once settlement. A request that already reached a terminal state
    // — finished normally, or expired by the reconciler's stale sweep — must
    // not be settled again. Without this, a merely-slow request that the sweep
    // already folded would be re-opened and folded a SECOND time when it
    // finally completes: totals double-count and the reservation is released
    // twice, dropping the reserved pool below reality and letting the atomic
    // check-and-reserve admit requests it should block.
    if (request.status !== "pending") {
      return { costCents: request.costCents ?? 0 };
    }

    // Clamp caller-supplied token counts: negatives would produce negative cost
    // and could refund a user below their cap.
    const promptTokens = Math.max(0, args.promptTokens ?? 0);
    const completionTokens = Math.max(0, args.completionTokens ?? 0);
    const costCents = Math.max(
      0,
      costOf(promptTokens, completionTokens, await getPrice(ctx, request.model))
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
  const estCost = req.estimatedCents ?? 0;
  const tokens = (req.promptTokens ?? 0) + (req.completionTokens ?? 0);
  const estTokens = req.estimatedTokens ?? 0;
  const today = dayStamp();

  const user = await getOrCreateUser(ctx, req.userId);
  const uSameDay = user.dayStamp === today;
  await ctx.db.patch(user._id, {
    totalSpendCents: user.totalSpendCents + actual,
    totalRequests: user.totalRequests + 1,
    totalTokens: user.totalTokens + tokens,
    dayStamp: today,
    spendTodayCents: (uSameDay ? user.spendTodayCents : 0) + actual,
    tokensToday: (uSameDay ? user.tokensToday ?? 0 : 0) + tokens,
    reservedTodayCents: Math.max(0, (uSameDay ? user.reservedTodayCents ?? 0 : 0) - estCost),
    reservedTotalCents: Math.max(0, (user.reservedTotalCents ?? 0) - estCost),
    reservedTodayTokens: Math.max(0, (uSameDay ? user.reservedTodayTokens ?? 0 : 0) - estTokens),
    reservedTotalTokens: Math.max(0, (user.reservedTotalTokens ?? 0) - estTokens),
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
      tokensToday: (aSameDay ? action.tokensToday ?? 0 : 0) + tokens,
      reservedTodayCents: Math.max(0, (aSameDay ? action.reservedTodayCents ?? 0 : 0) - estCost),
      reservedTotalCents: Math.max(0, (action.reservedTotalCents ?? 0) - estCost),
      reservedTodayTokens: Math.max(0, (aSameDay ? action.reservedTodayTokens ?? 0 : 0) - estTokens),
      reservedTotalTokens: Math.max(0, (action.reservedTotalTokens ?? 0) - estTokens),
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
    dailyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
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
    dailyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
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

export const getModelPolicy = query({
  args: {},
  returns: v.object({
    mode: v.union(
      v.literal("open"),
      v.literal("allowlist"),
      v.literal("denylist")
    ),
    models: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const s = await ctx.db
      .query("settings")
      .withIndex("key", (q) => q.eq("key", "singleton"))
      .unique();
    return { mode: s?.modelMode ?? "open", models: s?.models ?? [] };
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
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await getSettings(ctx);
    if (existing) {
      await ctx.db.patch(existing._id, {
        modelMode: args.mode,
        models: args.models,
      });
    } else {
      await ctx.db.insert("settings", {
        key: "singleton",
        modelMode: args.mode,
        models: args.models,
      });
    }
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
    // Negative prices would make costOf return a negative cost, which folds
    // into totals as a spend *refund* — pushing a user back under their cap.
    if (args.inputCentsPerMTok < 0 || args.outputCentsPerMTok < 0) {
      throw new Error("Prices must be non-negative");
    }
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
