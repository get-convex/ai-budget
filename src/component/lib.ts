import { v } from "convex/values";
import {
  mutation,
  internalMutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { api, internal, components } from "./_generated/api";
import { vMessage, vTag } from "./schema";
import type { Doc } from "./_generated/dataModel";
import { ShardedCounter } from "@convex-dev/sharded-counter";

// All money is integer **nanodollars** (1 USD = 1e9 nano). Integers avoid the
// rounding drift that floating-point cents accumulate over millions of
// requests, and keep cap comparisons exact. Nanodollars up to ~$9M are exact in
// a JS number (2^53); beyond that you'd move to int64. This is the single fixed
// currency (USD) for now — a future multi-currency version would carry a
// currency code alongside these amounts and convert here, at the one boundary.
const NANOS_PER_DOLLAR = 1e9;
const fmtUsd = (nanos: number) => `$${(nanos / NANOS_PER_DOLLAR).toFixed(4)}`;

// Built-in attribution dimensions. `user` and `action` are always populated
// from a request's userId/actionName; apps can add any other dimensions
// (team, project, customer, env, …) as tags. These two names are reserved —
// tags carrying them are ignored in favor of the first-class fields.
const USER_DIM = "user";
const ACTION_DIM = "action";

// Deployment-wide spend totals (nanodollars), sharded for high write throughput.
// Keyed "total" (lifetime) and "day:<UTC date>" (natural daily reset).
const globalSpend = new ShardedCounter(components.shardedCounter);
const GLOBAL_TOTAL = "total";
const globalDayKey = (stamp: string) => `day:${stamp}`;

// Fallback prices in NANODOLLARS per million tokens, used when no override is
// stored (e.g. gpt-4o-mini = $0.15 in / $0.60 out per Mtok).
const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4.5": { input: 3_000_000_000, output: 15_000_000_000 },
  "anthropic/claude-haiku-4.5": { input: 1_000_000_000, output: 5_000_000_000 },
  "openai/gpt-4o": { input: 2_500_000_000, output: 10_000_000_000 },
  "openai/gpt-4o-mini": { input: 150_000_000, output: 600_000_000 },
  "openai/gpt-5": { input: 1_250_000_000, output: 10_000_000_000 },
  "openai/gpt-5-mini": { input: 250_000_000, output: 2_000_000_000 },
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
// Default retention for request rows (full prompts + responses). Terminal,
// fully-accounted rows older than this are swept by the reconciler. Keeps the
// audit table — and the sensitive content in it — from growing without bound.
// Override per-deployment via setRetention.
const DEFAULT_RETENTION_MS = 60 * 60 * 1000; // 1 hour

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
      input: override.inputNanosPerMTok,
      output: override.outputNanosPerMTok,
      known: true,
    };
  }
  const known = DEFAULT_PRICES[model];
  if (known) return { ...known, known: true };
  return { ...CONSERVATIVE_PRICE, known: false };
}

// Integer nanodollars. Divide-before-multiply keeps the intermediate product
// within 2^53 even for large token counts × large per-Mtok prices.
const costOf = (
  inputTokens: number,
  outputTokens: number,
  price: { input: number; output: number }
) =>
  Math.round(
    (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output
  );

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

// The full set of attribution buckets a request touches: the built-in `user`
// and `action` dimensions plus any extra tags. Reserved dimensions in `extra`
// are dropped (userId/actionName own them), and (dimension, value) pairs are
// de-duplicated. Used identically at reserve time (startRequest) and settle
// time (foldOne), so a request always settles exactly the buckets it reserved.
function requestBuckets(
  userId: string,
  actionName: string | undefined,
  extra: { dimension: string; value: string }[] | undefined
): { dimension: string; value: string }[] {
  const out = [{ dimension: USER_DIM, value: userId }];
  if (actionName !== undefined)
    out.push({ dimension: ACTION_DIM, value: actionName });
  for (const t of extra ?? []) {
    if (t.dimension === USER_DIM || t.dimension === ACTION_DIM) continue;
    if (!t.dimension || !t.value) continue;
    if (out.some((x) => x.dimension === t.dimension && x.value === t.value))
      continue;
    out.push({ dimension: t.dimension, value: t.value });
  }
  return out;
}

// Drop reserved/empty/duplicate tags from a caller-supplied list, leaving the
// "extra" dimensions stored on the request row.
function sanitizeExtraTags(
  extra: { dimension: string; value: string }[] | undefined
): { dimension: string; value: string }[] {
  const out: { dimension: string; value: string }[] = [];
  for (const t of extra ?? []) {
    if (t.dimension === USER_DIM || t.dimension === ACTION_DIM) continue;
    if (!t.dimension || !t.value) continue;
    if (out.some((x) => x.dimension === t.dimension && x.value === t.value))
      continue;
    out.push({ dimension: t.dimension, value: t.value });
  }
  return out;
}

// Evaluate a bucket's spend + token budgets against committed + reserved + this
// request's estimate. Returns a hard rejection (block) or a list of soft
// warnings (allow), per the bucket's enforcement.
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
  dailySpendLimitNanos?: number;
  lifetimeSpendLimitNanos?: number;
  dailyTokenLimit?: number;
  lifetimeTokenLimit?: number;
}): { hard?: { code: string; reason: string }; warnings: string[] } {
  const violations: { code: string; reason: string }[] = [];
  const push = (code: string, reason: string) =>
    violations.push({ code: `${o.label}_${code}`, reason });

  if (
    o.dailySpendLimitNanos !== undefined &&
    o.spendToday + o.reservedSpendToday + o.estCost > o.dailySpendLimitNanos
  )
    push("daily_spend_limit", `Daily spend limit reached for ${o.label} "${o.name}" (${fmtUsd(o.dailySpendLimitNanos)}/day)`);
  if (
    o.lifetimeSpendLimitNanos !== undefined &&
    o.totalSpend + o.reservedSpendTotal + o.estCost > o.lifetimeSpendLimitNanos
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

// A cap plus any one-time bump. Returns undefined when there's no base cap
// (a bump alone never creates a cap).
const withBump = (base: number | undefined, bump: number | undefined) =>
  base === undefined ? undefined : base + (bump ?? 0);

const hasAnyCap = (e: {
  dailySpendLimitNanos?: number;
  lifetimeSpendLimitNanos?: number;
  dailyTokenLimit?: number;
  lifetimeTokenLimit?: number;
}) =>
  e.dailySpendLimitNanos !== undefined ||
  e.lifetimeSpendLimitNanos !== undefined ||
  e.dailyTokenLimit !== undefined ||
  e.lifetimeTokenLimit !== undefined;

async function getBucketDoc(ctx: MutationCtx, dimension: string, value: string) {
  return await ctx.db
    .query("buckets")
    .withIndex("dim_value", (q) =>
      q.eq("dimension", dimension).eq("value", value)
    )
    .unique();
}

async function getOrCreateBucket(
  ctx: MutationCtx,
  dimension: string,
  value: string
) {
  const existing = await getBucketDoc(ctx, dimension, value);
  if (existing) return existing;
  const id = await ctx.db.insert("buckets", {
    dimension,
    value,
    totalSpendNanos: 0,
    totalRequests: 0,
    totalTokens: 0,
    dayStamp: dayStamp(),
    spendTodayNanos: 0,
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
    // Extra attribution dimensions to bill/limit (team, customer, env, …).
    // `user` and `action` are reserved (owned by userId/actionName).
    tags: v.optional(v.array(vTag)),
    model: v.string(),
    messages: v.array(vMessage),
    rerunOf: v.optional(v.id("requests")),
  },
  returns: vStartResult,
  handler: async (ctx, args) => {
    const extraTags = sanitizeExtraTags(args.tags);
    // Record the blocked attempt and return a rejection (throwing would roll
    // back the record). `persist` is false for the high-frequency-by-design
    // rejections (rate limit, blocked user) that a client retries in a tight
    // loop — persisting those would grow the requests table without bound and
    // bloat the 60s rate-limit window read below.
    const reject = async (code: string, reason: string, persist = true) => {
      if (persist) {
        await ctx.db.insert("requests", {
          userId: args.userId,
          actionName: args.actionName,
          ...(extraTags.length ? { tags: extraTags } : {}),
          model: args.model,
          messages: args.messages,
          rerunOf: args.rerunOf,
          status: "blocked" as const,
          error: reason,
        });
      }
      return { allowed: false as const, code, reason };
    };

    const today = dayStamp();
    const priceInfo = await getPrice(ctx, args.model);
    const est = estimateUsage(args.messages, priceInfo);
    const warnings: string[] = [];

    // Model allow/deny policy (component-wide).
    const settings = await getSettings(ctx);
    if (settings) {
      const mode = settings.modelMode ?? "open";
      const list = settings.models ?? [];
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

    // Fetch/create every bucket this request is attributed to (user, action,
    // and any extra tags). Each may carry its own budget.
    const bucketTags = requestBuckets(args.userId, args.actionName, extraTags);
    const buckets: Doc<"buckets">[] = [];
    for (const t of bucketTags) {
      buckets.push(await getOrCreateBucket(ctx, t.dimension, t.value));
    }

    // A hard block on ANY bucket rejects the request. The user dimension's block
    // isn't persisted (retried in a loop); config-level blocks on other
    // dimensions are rarer, so they persist for the audit log.
    for (const b of buckets) {
      if (b.blocked) {
        const label = b.dimension === USER_DIM ? "User" : b.dimension;
        return reject(
          `${b.dimension}_blocked`,
          `${label} "${b.value}" is blocked`,
          b.dimension !== USER_DIM
        );
      }
    }

    // Rate limit is enforced on the `user` dimension (the requests table is
    // indexed by userId, so the 60s window is a bounded index read).
    const userBucket = buckets.find((b) => b.dimension === USER_DIM)!;
    if (userBucket.requestsPerMinute !== undefined) {
      // Bounded read: we only need to know whether non-blocked requests in the
      // window have reached the limit. Reading limit+50 non-blocked rows is
      // enough, and .take caps the scan even if the window is flooded. Blocked
      // rows aren't persisted for rate-limit/blocked rejections (see reject),
      // so the window stays small.
      const recent = await ctx.db
        .query("requests")
        .withIndex("userId", (q) =>
          q.eq("userId", args.userId).gt("_creationTime", Date.now() - 60_000)
        )
        .take(userBucket.requestsPerMinute + 50);
      if (
        recent.filter((r) => r.status !== "blocked").length >=
        userBucket.requestsPerMinute
      ) {
        return reject(
          "rate_limit",
          `Rate limit exceeded for "${args.userId}" (${userBucket.requestsPerMinute}/min)`,
          false
        );
      }
    }

    // Committed + already-reserved in-flight usage + this estimate must fit
    // under EACH bucket's cap. Decided and reserved in one transaction, so
    // Convex's serializable isolation makes it a true atomic check-and-reserve
    // across every capped bucket. Soft enforcement turns a violation into a
    // warning instead of a block.
    for (const b of buckets) {
      const sameDay = b.dayStamp === today;
      const ev = evaluateCaps({
        label: b.dimension,
        name: b.value,
        enforcement: b.enforcement ?? "hard",
        estCost: est.cost,
        estTokens: est.tokens,
        spendToday: sameDay ? b.spendTodayNanos : 0,
        reservedSpendToday: sameDay ? b.reservedTodayNanos ?? 0 : 0,
        totalSpend: b.totalSpendNanos,
        reservedSpendTotal: b.reservedTotalNanos ?? 0,
        tokensToday: sameDay ? b.tokensToday ?? 0 : 0,
        reservedTokensToday: sameDay ? b.reservedTodayTokens ?? 0 : 0,
        totalTokens: b.totalTokens,
        reservedTokensTotal: b.reservedTotalTokens ?? 0,
        dailySpendLimitNanos: withBump(
          b.dailySpendLimitNanos,
          b.bumpDayStamp === today ? b.dailyBumpNanos : 0
        ),
        lifetimeSpendLimitNanos: withBump(
          b.lifetimeSpendLimitNanos,
          b.lifetimeBumpNanos
        ),
        dailyTokenLimit: b.dailyTokenLimit,
        lifetimeTokenLimit: b.lifetimeTokenLimit,
      });
      if (ev.hard) return reject(ev.hard.code, ev.hard.reason);
      warnings.push(...ev.warnings);
    }

    // Deployment-wide ("global") spend cap — same reserve-then-settle model and
    // the SAME evaluateCaps logic as the per-bucket caps above, so the guarantee
    // statement is uniform: a request is admitted only if
    // committed + reserved + estimate <= cap. The ONE difference is the holder:
    // per-bucket caps reserve on a single row (an exact atomic
    // check-and-reserve), while the global holder is a sharded counter for
    // throughput — its committed total is read as an eventually-consistent sum
    // with no cross-request reservation, so a hard global cap can overshoot by a
    // bounded amount under burst. That's the deliberate exactness/throughput
    // trade for a deployment-wide killswitch; it's the only approximate scope.
    if (
      settings &&
      (settings.globalDailySpendLimitNanos !== undefined ||
        settings.globalLifetimeSpendLimitNanos !== undefined)
    ) {
      const globalEval = evaluateCaps({
        label: "global",
        name: "deployment",
        enforcement: settings.globalEnforcement ?? "hard",
        estCost: est.cost,
        estTokens: est.tokens,
        spendToday: await globalSpend.count(ctx, globalDayKey(today)),
        reservedSpendToday: 0, // sharded holder: no cross-request reservation
        totalSpend: await globalSpend.count(ctx, GLOBAL_TOTAL),
        reservedSpendTotal: 0,
        tokensToday: 0,
        reservedTokensToday: 0,
        totalTokens: 0,
        reservedTokensTotal: 0,
        dailySpendLimitNanos: withBump(
          settings.globalDailySpendLimitNanos,
          settings.globalBumpDayStamp === today ? settings.globalDailyBumpNanos : 0
        ),
        lifetimeSpendLimitNanos: withBump(
          settings.globalLifetimeSpendLimitNanos,
          settings.globalLifetimeBumpNanos
        ),
      });
      if (globalEval.hard) return reject(globalEval.hard.code, globalEval.hard.reason);
      warnings.push(...globalEval.warnings);
    }

    // Passed — reserve, but ONLY on buckets that actually have a cap. Writing an
    // uncapped bucket's row here would serialize every request that shares it
    // (e.g. all callers of one action, or every request in one env); with no cap
    // there's no reserved amount to consult. Totals are still accrued later,
    // asynchronously, in foldOne — for every bucket, capped or not.
    for (const b of buckets) {
      if (!hasAnyCap(b)) continue;
      const sameDay = b.dayStamp === today;
      await ctx.db.patch(b._id, {
        dayStamp: today,
        spendTodayNanos: sameDay ? b.spendTodayNanos : 0,
        tokensToday: sameDay ? b.tokensToday ?? 0 : 0,
        reservedTodayNanos: (sameDay ? b.reservedTodayNanos ?? 0 : 0) + est.cost,
        reservedTotalNanos: (b.reservedTotalNanos ?? 0) + est.cost,
        reservedTodayTokens: (sameDay ? b.reservedTodayTokens ?? 0 : 0) + est.tokens,
        reservedTotalTokens: (b.reservedTotalTokens ?? 0) + est.tokens,
        pendingCount: (b.pendingCount ?? 0) + 1,
      });
    }
    const requestId = await ctx.db.insert("requests", {
      userId: args.userId,
      actionName: args.actionName,
      ...(extraTags.length ? { tags: extraTags } : {}),
      model: args.model,
      messages: args.messages,
      rerunOf: args.rerunOf,
      status: "pending",
      estimatedNanos: est.cost,
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
    cachedTokens: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
  },
  returns: v.object({ costNanos: v.number() }),
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
      return { costNanos: request.costNanos ?? 0 };
    }

    // Clamp caller-supplied token counts: negatives would produce negative cost
    // and could refund a user below their cap.
    const promptTokens = Math.max(0, args.promptTokens ?? 0);
    const completionTokens = Math.max(0, args.completionTokens ?? 0);
    const cachedTokens = Math.min(promptTokens, Math.max(0, args.cachedTokens ?? 0));
    const costNanos = Math.max(
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
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
      costNanos,
      latencyMs: args.latencyMs,
      settled: false,
    });

    // Fold into the (hot) per-bucket counters in a separate mutation. If it
    // exhausts retries under contention, the cron reconciler picks it up.
    await ctx.scheduler.runAfter(0, internal.lib.foldTotals, {
      requestId: args.requestId,
    });
    return { costNanos };
  },
});

// Fold one finished request into every attributed bucket's running totals,
// releasing its reservation. Idempotent: guarded by `settled` so the scheduler
// and the cron reconciler can never double-count.
async function foldOne(ctx: MutationCtx, req: Doc<"requests"> | null) {
  if (!req || req.settled !== false) return;
  const actual = req.costNanos ?? 0;
  const estCost = req.estimatedNanos ?? 0;
  const tokens = (req.promptTokens ?? 0) + (req.completionTokens ?? 0);
  const estTokens = req.estimatedTokens ?? 0;
  const today = dayStamp();

  // Accrue into every attributed bucket (user, action, and each tag) — capped
  // or not. Buckets that never held a reservation have their reserved fields
  // clamped at 0 by Math.max, so subtracting an estimate is a harmless no-op.
  for (const t of requestBuckets(req.userId, req.actionName, req.tags)) {
    const b = await getOrCreateBucket(ctx, t.dimension, t.value);
    const sameDay = b.dayStamp === today;
    await ctx.db.patch(b._id, {
      totalSpendNanos: b.totalSpendNanos + actual,
      totalRequests: b.totalRequests + 1,
      totalTokens: b.totalTokens + tokens,
      dayStamp: today,
      spendTodayNanos: (sameDay ? b.spendTodayNanos : 0) + actual,
      tokensToday: (sameDay ? b.tokensToday ?? 0 : 0) + tokens,
      reservedTodayNanos: Math.max(0, (sameDay ? b.reservedTodayNanos ?? 0 : 0) - estCost),
      reservedTotalNanos: Math.max(0, (b.reservedTotalNanos ?? 0) - estCost),
      reservedTodayTokens: Math.max(0, (sameDay ? b.reservedTodayTokens ?? 0 : 0) - estTokens),
      reservedTotalTokens: Math.max(0, (b.reservedTotalTokens ?? 0) - estTokens),
      pendingCount: Math.max(0, (b.pendingCount ?? 0) - 1),
    });
  }

  // Deployment-wide totals via the sharded counter (only when a global cap is
  // configured — otherwise skip the writes entirely). Distributed across shards,
  // so this does not serialize on a single row.
  if (actual > 0) {
    const settings = await getSettings(ctx);
    if (
      settings &&
      (settings.globalDailySpendLimitNanos !== undefined ||
        settings.globalLifetimeSpendLimitNanos !== undefined)
    ) {
      await globalSpend.add(ctx, GLOBAL_TOTAL, actual);
      await globalSpend.add(ctx, globalDayKey(today), actual);
    }
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
  returns: v.object({
    folded: v.number(),
    expired: v.number(),
    purged: v.number(),
  }),
  handler: async (ctx) => {
    const toFold = await ctx.db
      .query("requests")
      .withIndex("settled", (q) => q.eq("settled", false))
      .take(200);
    for (const req of toFold) await foldOne(ctx, req);

    const cutoff = Date.now() - STALE_PENDING_MS;
    const stale = await ctx.db
      .query("requests")
      .withIndex("status", (q) =>
        q.eq("status", "pending").lt("_creationTime", cutoff)
      )
      .take(200);
    for (const req of stale) {
      await ctx.db.patch(req._id, {
        status: "error",
        error: "Timed out before settling; reservation released",
        costNanos: 0,
        settled: false,
      });
      await foldOne(ctx, await ctx.db.get(req._id));
    }

    // Retention: delete terminal, fully-accounted request rows past the window.
    const settings = await getSettings(ctx);
    const retentionMs = settings?.retentionMs ?? DEFAULT_RETENTION_MS;
    let purged = 0;
    if (retentionMs > 0) {
      const retentionCutoff = Date.now() - retentionMs;
      const old = await ctx.db
        .query("requests")
        .withIndex("by_creation_time", (q) =>
          q.lt("_creationTime", retentionCutoff)
        )
        .take(500);
      for (const req of old) {
        // Only rows that are done and accounted: folded (settled === true) or a
        // blocked attempt (never needs folding). Never a pending/unfolded row.
        if (req.settled === true || req.status === "blocked") {
          await ctx.db.delete(req._id);
          purged++;
        }
      }
    }
    return { folded: toFold.length, expired: stale.length, purged };
  },
});

export const setRetention = mutation({
  args: { retentionMs: v.number() },
  returns: v.null(),
  handler: async (ctx, { retentionMs }) => {
    const existing = await getSettings(ctx);
    if (existing) await ctx.db.patch(existing._id, { retentionMs });
    else await ctx.db.insert("settings", { key: "singleton", retentionMs });
    return null;
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

const ADMIN_LIST_CAP = 2000;

// List budget buckets, optionally filtered to one dimension ("user", "action",
// or any custom tag dimension). Today's spend is zeroed for stale day windows.
export const listBuckets = query({
  args: { dimension: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Bounded to avoid an unbounded full-table scan on this reactive query.
    // Paginate (ctx.db.query("buckets").paginate(...)) for larger deployments.
    const rows =
      args.dimension !== undefined
        ? await ctx.db
            .query("buckets")
            .withIndex("dimension", (q) => q.eq("dimension", args.dimension!))
            .take(ADMIN_LIST_CAP)
        : await ctx.db.query("buckets").take(ADMIN_LIST_CAP);
    const today = dayStamp();
    return rows.map((b) => ({
      ...b,
      spendTodayNanos: b.dayStamp === today ? b.spendTodayNanos : 0,
    }));
  },
});

export const getBucket = query({
  args: { dimension: v.string(), value: v.string() },
  handler: async (ctx, args) => {
    const b = await getBucketDoc(ctx as any, args.dimension, args.value);
    if (!b) return null;
    const today = dayStamp();
    return { ...b, spendTodayNanos: b.dayStamp === today ? b.spendTodayNanos : 0 };
  },
});

// Set a bucket's limits/controls. `user` and `action` are just dimensions here;
// the client's ai.users / ai.actions namespaces are thin wrappers over this.
export const setBucketLimits = mutation({
  args: {
    dimension: v.string(),
    value: v.string(),
    requestsPerMinute: v.optional(v.number()),
    dailySpendLimitNanos: v.optional(v.number()),
    lifetimeSpendLimitNanos: v.optional(v.number()),
    dailyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
    blocked: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const bucket = await getOrCreateBucket(ctx, args.dimension, args.value);
    const { dimension: _d, value: _v, ...limits } = args;
    await ctx.db.patch(bucket._id, limits);
    return null;
  },
});

const vBumpArgs = {
  dailyNanos: v.optional(v.number()),
  lifetimeNanos: v.optional(v.number()),
};

// One-time "approve another $X" bumps, added on top of a bucket's standing cap
// without changing it. Daily bumps apply to today only; lifetime bumps persist.
export const bumpBucket = mutation({
  args: { dimension: v.string(), value: v.string(), ...vBumpArgs },
  returns: v.null(),
  handler: async (ctx, { dimension, value, dailyNanos, lifetimeNanos }) => {
    const bucket = await getOrCreateBucket(ctx, dimension, value);
    const today = dayStamp();
    const curDaily =
      bucket.bumpDayStamp === today ? bucket.dailyBumpNanos ?? 0 : 0;
    await ctx.db.patch(bucket._id, {
      bumpDayStamp: today,
      dailyBumpNanos: curDaily + (dailyNanos ?? 0),
      lifetimeBumpNanos: (bucket.lifetimeBumpNanos ?? 0) + (lifetimeNanos ?? 0),
    });
    return null;
  },
});

// Delete a bucket and (for the `user` dimension) all of that user's request
// rows — e.g. account deletion / GDPR. Deletes requests in bounded batches and
// self-reschedules so it never exceeds the per-transaction document limit.
const DELETE_BATCH = 500;
export const deleteBucket = mutation({
  args: { dimension: v.string(), value: v.string() },
  returns: v.object({ deletedThisBatch: v.number(), done: v.boolean() }),
  handler: async (ctx, { dimension, value }) => {
    // Only the user dimension owns request rows (indexed by userId). Other
    // dimensions just drop their budget-holder row.
    if (dimension === USER_DIM) {
      const rows = await ctx.db
        .query("requests")
        .withIndex("userId", (q) => q.eq("userId", value))
        .take(DELETE_BATCH);
      for (const r of rows) await ctx.db.delete(r._id);
      if (rows.length === DELETE_BATCH) {
        await ctx.scheduler.runAfter(0, api.lib.deleteBucket, {
          dimension,
          value,
        });
        return { deletedThisBatch: rows.length, done: false };
      }
      const bucket = await getBucketDoc(ctx, dimension, value);
      if (bucket) await ctx.db.delete(bucket._id);
      return { deletedThisBatch: rows.length + (bucket ? 1 : 0), done: true };
    }
    const bucket = await getBucketDoc(ctx, dimension, value);
    if (bucket) await ctx.db.delete(bucket._id);
    return { deletedThisBatch: bucket ? 1 : 0, done: true };
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

export const getGlobalStatus = query({
  args: {},
  returns: v.object({
    dailySpendLimitNanos: v.union(v.number(), v.null()),
    lifetimeSpendLimitNanos: v.union(v.number(), v.null()),
    enforcement: v.union(v.literal("hard"), v.literal("soft")),
    spentTodayNanos: v.number(),
    spentTotalNanos: v.number(),
  }),
  handler: async (ctx) => {
    const s = await ctx.db
      .query("settings")
      .withIndex("key", (q) => q.eq("key", "singleton"))
      .unique();
    return {
      dailySpendLimitNanos: s?.globalDailySpendLimitNanos ?? null,
      lifetimeSpendLimitNanos: s?.globalLifetimeSpendLimitNanos ?? null,
      enforcement: s?.globalEnforcement ?? "hard",
      spentTodayNanos: await globalSpend.count(ctx, globalDayKey(dayStamp())),
      spentTotalNanos: await globalSpend.count(ctx, GLOBAL_TOTAL),
    };
  },
});

export const setGlobalLimits = mutation({
  args: {
    dailySpendLimitNanos: v.optional(v.number()),
    lifetimeSpendLimitNanos: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // The settings fields are "global"-prefixed; map the friendly arg names.
    const patch = {
      globalDailySpendLimitNanos: args.dailySpendLimitNanos,
      globalLifetimeSpendLimitNanos: args.lifetimeSpendLimitNanos,
      globalEnforcement: args.enforcement,
    };
    const existing = await getSettings(ctx);
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("settings", { key: "singleton", ...patch });
    }
    return null;
  },
});

export const bumpGlobal = mutation({
  args: vBumpArgs,
  returns: v.null(),
  handler: async (ctx, { dailyNanos, lifetimeNanos }) => {
    const today = dayStamp();
    const s = await getSettings(ctx);
    const curDaily = s?.globalBumpDayStamp === today ? s?.globalDailyBumpNanos ?? 0 : 0;
    const patch = {
      globalBumpDayStamp: today,
      globalDailyBumpNanos: curDaily + (dailyNanos ?? 0),
      globalLifetimeBumpNanos: (s?.globalLifetimeBumpNanos ?? 0) + (lifetimeNanos ?? 0),
    };
    if (s) await ctx.db.patch(s._id, patch);
    else await ctx.db.insert("settings", { key: "singleton", ...patch });
    return null;
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
    inputNanosPerMTok: v.number(),
    outputNanosPerMTok: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Negative prices would make costOf return a negative cost, which folds
    // into totals as a spend *refund* — pushing a user back under their cap.
    if (args.inputNanosPerMTok < 0 || args.outputNanosPerMTok < 0) {
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
        input: o.inputNanosPerMTok,
        output: o.outputNanosPerMTok,
        overridden: true,
      };
    }
    return merged;
  },
});
