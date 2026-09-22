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
import { RateLimiter, MINUTE } from "@convex-dev/rate-limiter";
import { ShardedCounter } from "@convex-dev/sharded-counter";

// All money is integer **nanodollars** (1 USD = 1e9 nano). Integers avoid the
// rounding drift that floating-point cents accumulate over millions of
// requests, and keep cap comparisons exact. Nanodollars up to ~$9M are exact in
// a JS number (2^53); beyond that you'd move to int64. This is the single fixed
// currency (USD) for now — a future multi-currency version would carry a
// currency code alongside these amounts and convert here, at the one boundary.
const NANOS_PER_DOLLAR = 1e9;
const fmtUsd = (nanos: number) => `$${(nanos / NANOS_PER_DOLLAR).toFixed(4)}`;

// Convex's `v.number()` accepts NaN and ±Infinity. Those are poison here: a NaN
// cap or count silently defeats every `used > cap` comparison (NaN > x is
// false), so an unvalidated NaN would make admission fail OPEN and admit
// unlimited spend; +Infinity in totals is just as corrupting. Validate every
// externally-supplied accounting amount at the mutation boundary.
function assertAmount(
  n: number | undefined,
  name: string,
  { signed = false }: { signed?: boolean } = {}
) {
  if (n === undefined) return;
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new Error(`${name} must be a finite safe integer (got ${n})`);
  }
  if (!signed && n < 0) throw new Error(`${name} must be nonnegative (got ${n})`);
}
function assertFraction(n: number | undefined, name: string) {
  if (n === undefined) return;
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${name} must be a number in [0, 1] (got ${n})`);
  }
}
// Coerce a caller/provider-supplied count to a finite nonnegative integer,
// mapping NaN/Infinity/garbage to 0 rather than poisoning downstream totals.
const safeCount = (n: number | undefined) =>
  Number.isFinite(n) ? Math.max(0, Math.floor(n as number)) : 0;

// Built-in attribution dimensions. `user` and `action` are always populated
// from a request's userId/actionName; apps can add any other dimensions
// (team, project, customer, env, …) as tags. These two names are reserved —
// tags carrying them are ignored in favor of the first-class fields.
const USER_DIM = "user";
const ACTION_DIM = "action";

const requestRateLimiter = new RateLimiter(components.rateLimiter);
const requestRateOptions = (bucket: Doc<"buckets">) => ({
  key: bucket._id,
  config: {
    kind: "token bucket" as const,
    rate: bucket.requestsPerMinute!,
    capacity: bucket.requestsPerMinute!,
    period: MINUTE,
  },
});

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

// Per-call price (nanodollars) for provider server-side tools that bill a fee on
// top of tokens — e.g. Anthropic web search at ~$0.01/call. Keyed by the tool
// name the caller reports in `serverToolUses` (e.g. { web_search: 3 }). Used
// only when a request settles WITHOUT an authoritative gateway cost; if you pass
// `costNanos`, that already includes tool fees. Override via setServerToolPrice.
const DEFAULT_SERVER_TOOL_PRICES: Record<string, number> = {
  web_search: 10_000_000, // $0.01 per search
};

// Pessimistic assumed output length when reserving budget up front. This makes
// concurrent admission atomic against the estimate; a response that exceeds the
// estimate can still settle above the cap by the estimation delta.
const ESTIMATED_OUTPUT_TOKENS = 800;
// Expiry releases a hold without declaring final usage. A late provider
// completion can still record its authoritative charge exactly once.
const STALE_PENDING_MS = 30 * 60 * 1000;
// Default retention for request rows (full prompts + responses). Terminal,
// fully-accounted rows older than this are swept by the reconciler. Keeps the
// audit table — and the sensitive content in it — from growing without bound.
// Override per-deployment via setRetention.
const DEFAULT_RETENTION_MS = 60 * 60 * 1000; // 1 hour

const dayStamp = () => new Date().toISOString().slice(0, 10); // "2026-09-04"
const monthStamp = () => new Date().toISOString().slice(0, 7); // "2026-09"

// Cached (prompt-cache-read) input tokens are billed far below the normal input
// rate. When a model's price has no explicit cachedNanosPerMTok, charge this
// fraction of its input rate (providers commonly discount ~90%).
const CACHE_DISCOUNT = 0.1;

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
      cached: override.cachedNanosPerMTok,
      known: true,
    };
  }
  const known = DEFAULT_PRICES[model];
  if (known) return { ...known, cached: undefined, known: true };
  return { ...CONSERVATIVE_PRICE, cached: undefined, known: false };
}

type Price = { input: number; output: number; cached?: number };
// The per-Mtok rate for cached (prompt-cache-read) tokens: an explicit override,
// else a discount off the input rate.
const cachedRate = (p: Price) =>
  p.cached ?? Math.round(p.input * CACHE_DISCOUNT);

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

// Cache-aware settle cost: the cached slice of the prompt is billed at the
// (discounted) cache rate, the rest of the prompt at the input rate, and
// completions at the output rate. `cachedTokens` is the gateway's real
// prompt-cache-read count (usage.inputTokenDetails.cacheReadTokens).
const settleCost = (
  promptTokens: number,
  cachedTokens: number,
  completionTokens: number,
  price: Price
) => {
  const cached = Math.min(Math.max(0, cachedTokens), Math.max(0, promptTokens));
  const fresh = Math.max(0, promptTokens - cached);
  return Math.round(
    (fresh / 1e6) * price.input +
      (cached / 1e6) * cachedRate(price) +
      (completionTokens / 1e6) * price.output
  );
};

// Per-call fees for provider server tools (web search, etc.), merging the
// defaults with any deployment overrides. Unknown tools price at 0 (recorded
// but not charged) rather than guessing.
const serverToolCost = (
  uses: Record<string, number> | undefined,
  overrides: Record<string, number> | undefined
) => {
  if (!uses) return 0;
  const prices = { ...DEFAULT_SERVER_TOOL_PRICES, ...(overrides ?? {}) };
  let total = 0;
  for (const [tool, count] of Object.entries(uses)) {
    if (count > 0 && prices[tool] > 0) total += Math.round(count * prices[tool]);
  }
  return total;
};

// Upsert-add a settled amount into the durable per-(bucket, period) usage row.
// These rows are never swept by request retention, so spend history survives.
async function addUsage(
  ctx: MutationCtx,
  dimension: string,
  value: string,
  period: "day" | "month",
  stamp: string,
  spendNanos: number,
  tokens: number,
  requests: number
) {
  const existing = await ctx.db
    .query("usage")
    .withIndex("bucket_period_stamp", (q) =>
      q
        .eq("dimension", dimension)
        .eq("value", value)
        .eq("period", period)
        .eq("stamp", stamp)
    )
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, {
      spendNanos: existing.spendNanos + spendNanos,
      tokens: existing.tokens + tokens,
      requests: existing.requests + requests,
    });
  } else {
    await ctx.db.insert("usage", {
      dimension,
      value,
      period,
      stamp,
      spendNanos,
      tokens,
      requests,
    });
  }
}

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
// request's estimate. Returns a hard rejection (block), soft warnings (allow),
// and threshold notices (approaching a cap — see warnAtPct). Each window (daily,
// monthly, lifetime) × kind (spend, token) is one check.
function evaluateCaps(o: {
  label: string;
  name: string;
  enforcement: "hard" | "soft";
  warnAtPct?: number;
  estCost: number;
  estTokens: number;
  spendToday: number;
  reservedSpendToday: number;
  spendThisMonth: number;
  reservedSpendMonth: number;
  totalSpend: number;
  reservedSpendTotal: number;
  tokensToday: number;
  reservedTokensToday: number;
  tokensThisMonth: number;
  reservedTokensMonth: number;
  totalTokens: number;
  reservedTokensTotal: number;
  dailySpendLimitNanos?: number;
  monthlySpendLimitNanos?: number;
  lifetimeSpendLimitNanos?: number;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  lifetimeTokenLimit?: number;
}): {
  hard?: { code: string; reason: string };
  warnings: string[];
  notices: string[];
} {
  // { code, projected usage (incl. this estimate), cap, human window label,
  //   whether it's a money cap (formatted as $), spend? for notices }
  const checks = [
    { w: "daily_spend_limit", used: o.spendToday + o.reservedSpendToday + o.estCost, cap: o.dailySpendLimitNanos, label: "daily spend limit", money: true },
    { w: "monthly_spend_limit", used: o.spendThisMonth + o.reservedSpendMonth + o.estCost, cap: o.monthlySpendLimitNanos, label: "monthly spend limit", money: true },
    { w: "lifetime_spend_limit", used: o.totalSpend + o.reservedSpendTotal + o.estCost, cap: o.lifetimeSpendLimitNanos, label: "lifetime spend limit", money: true },
    { w: "daily_token_limit", used: o.tokensToday + o.reservedTokensToday + o.estTokens, cap: o.dailyTokenLimit, label: "daily token limit", money: false },
    { w: "monthly_token_limit", used: o.tokensThisMonth + o.reservedTokensMonth + o.estTokens, cap: o.monthlyTokenLimit, label: "monthly token limit", money: false },
    { w: "lifetime_token_limit", used: o.totalTokens + o.reservedTokensTotal + o.estTokens, cap: o.lifetimeTokenLimit, label: "lifetime token limit", money: false },
  ];

  const violations: { code: string; reason: string }[] = [];
  const notices: string[] = [];
  const pct = o.warnAtPct;
  for (const c of checks) {
    if (c.cap === undefined) continue;
    const capStr = c.money ? `${fmtUsd(c.cap)}` : `${c.cap} tokens`;
    if (c.used > c.cap) {
      violations.push({
        code: `${o.label}_${c.w}`,
        reason: `${cap(c.label)} reached for ${o.label} "${o.name}" (${capStr})`,
      });
    } else if (pct !== undefined && pct > 0 && pct < 1 && c.used >= pct * c.cap) {
      notices.push(
        `${o.label} "${o.name}" at ${Math.round((c.used / c.cap) * 100)}% of ${c.label} (${capStr})`
      );
    }
  }

  if (violations.length === 0) return { warnings: [], notices };
  if (o.enforcement === "soft")
    return { warnings: violations.map((v) => v.reason), notices };
  return { hard: violations[0], warnings: [], notices };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// A cap plus any one-time bump. Returns undefined when there's no base cap
// (a bump alone never creates a cap).
const withBump = (base: number | undefined, bump: number | undefined) =>
  base === undefined ? undefined : base + (bump ?? 0);

const hasAnyCap = (e: {
  dailySpendLimitNanos?: number;
  monthlySpendLimitNanos?: number;
  lifetimeSpendLimitNanos?: number;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  lifetimeTokenLimit?: number;
}) =>
  e.dailySpendLimitNanos !== undefined ||
  e.monthlySpendLimitNanos !== undefined ||
  e.lifetimeSpendLimitNanos !== undefined ||
  e.dailyTokenLimit !== undefined ||
  e.monthlyTokenLimit !== undefined ||
  e.lifetimeTokenLimit !== undefined;

// A bucket needs a reservation row-write if it has any spend/token cap OR a
// concurrency cap (which reads pendingCount, incremented at reserve time).
const needsReserve = (e: Parameters<typeof hasAnyCap>[0] & { maxConcurrent?: number }) =>
  hasAnyCap(e) || e.maxConcurrent !== undefined;

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

// Policy is read on every admission; reporting writes never touch it.
async function syncPolicy(ctx: MutationCtx, b: Doc<"buckets">) {
  const existing = await ctx.db.query("bucketPolicies").withIndex("dim_value", q =>
    q.eq("dimension", b.dimension).eq("value", b.value)).unique();
  const policy = {
    bucketId: b._id, dimension: b.dimension, value: b.value,
    requestsPerMinute: b.requestsPerMinute, maxConcurrent: b.maxConcurrent,
    dailySpendLimitNanos: b.dailySpendLimitNanos, monthlySpendLimitNanos: b.monthlySpendLimitNanos,
    lifetimeSpendLimitNanos: b.lifetimeSpendLimitNanos, dailyTokenLimit: b.dailyTokenLimit,
    monthlyTokenLimit: b.monthlyTokenLimit, lifetimeTokenLimit: b.lifetimeTokenLimit,
    blocked: b.blocked, warnAtPct: b.warnAtPct, enforcement: b.enforcement,
  };
  if (existing) await ctx.db.replace(existing._id, policy);
  else await ctx.db.insert("bucketPolicies", policy);
}

async function admissionBucket(ctx: MutationCtx, dimension: string, value: string): Promise<Doc<"buckets">> {
  const policy = await ctx.db.query("bucketPolicies").withIndex("dim_value", q =>
    q.eq("dimension", dimension).eq("value", value)).unique();
  if (!policy) {
    const bucket = await getOrCreateBucket(ctx, dimension, value);
    await syncPolicy(ctx, bucket);
    return bucket;
  }
  // Only capped buckets need an atomic read of their accounting state.
  if (needsReserve(policy)) return (await ctx.db.get(policy.bucketId))!;
  return { ...policy, _id: policy.bucketId, totalSpendNanos: 0, totalRequests: 0,
    totalTokens: 0, dayStamp: "", spendTodayNanos: 0 };
}

async function getSettings(ctx: MutationCtx) {
  return await ctx.db
    .query("settings")
    .withIndex("key", (q) => q.eq("key", "singleton"))
    .unique();
}

// Delete the reverse-index rows for a request (called when the request row is
// deleted, so the tag index never outlives the request it points at).
async function deleteRequestTags(ctx: MutationCtx, requestId: Doc<"requests">["_id"]) {
  const tags = await ctx.db
    .query("requestTags")
    .withIndex("requestId", (q) => q.eq("requestId", requestId))
    .collect();
  for (const t of tags) await ctx.db.delete(t._id);
}

const vStartResult = v.union(
  v.object({
    allowed: v.literal(true),
    requestId: v.id("requests"),
    warnings: v.array(v.string()), // soft caps exceeded (allowed with a warning)
    notices: v.array(v.string()), // approaching a cap (warnAtPct threshold)
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
    // Reserve this exact amount (nanodollars) instead of the token-based
    // estimate. Use it whenever the cost is known up front — image generation
    // (n × per-image), audio, per-call APIs — so a hard cap reserves the real
    // amount rather than a meaningless token guess.
    estimatedCostNanos: v.optional(v.number()),
    // Hold the reservation this long (ms) before the reconciler may reap it —
    // for long async jobs (video) that settle minutes later. Extends the 30-min
    // default floor.
    reserveTtlMs: v.optional(v.number()),
    rerunOf: v.optional(v.id("requests")),
  },
  returns: vStartResult,
  handler: async (ctx, args) => {
    if (args.reserveTtlMs !== undefined && (!Number.isFinite(args.reserveTtlMs) || args.reserveTtlMs < 0)) {
      throw new Error("reserveTtlMs must be finite and nonnegative");
    }
    const extraTags = sanitizeExtraTags(args.tags);
    // Record the blocked attempt and return a rejection (throwing would roll
    // back the record). `persist` is false for the high-frequency-by-design
    // rejections (rate limit, blocked user) that a client retries in a tight
    // loop — persisting those would grow the requests table without bound and
    // add audit-log writes to every transient rejection.
    const reject = async (code: string, reason: string, persist = true) => {
      if (persist) {
        const requestId = await ctx.db.insert("requests", {
          userId: args.userId,
          actionName: args.actionName,
          ...(extraTags.length ? { tags: extraTags } : {}),
          model: args.model,
          messages: args.messages,
          rerunOf: args.rerunOf,
          status: "blocked" as const,
          error: reason,
        });
        // Reverse-index the blocked attempt too, so tag-filtered request logs
        // show rejections alongside admitted traffic.
        for (const t of extraTags) {
          await ctx.db.insert("requestTags", {
            dimension: t.dimension,
            value: t.value,
            requestId,
          });
        }
      }
      return { allowed: false as const, code, reason };
    };

    const today = dayStamp();
    const month = monthStamp();
    const priceInfo = await getPrice(ctx, args.model);
    const est = estimateUsage(args.messages, priceInfo);
    // A caller-supplied known cost (image gen, audio, per-call APIs) reserves
    // the real amount up front; the token estimate stays as the token reserve.
    if (args.estimatedCostNanos !== undefined && args.estimatedCostNanos >= 0) {
      est.cost = Math.round(args.estimatedCostNanos);
    }
    const warnings: string[] = [];
    const notices: string[] = [];

    // Model allow/deny policy (component-wide).
    const settings = await getSettings(ctx);
    const defaultWarnAtPct = settings?.defaultWarnAtPct;
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
      buckets.push(await admissionBucket(ctx, t.dimension, t.value));
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

    // Concurrency cap: reject when a bucket already has maxConcurrent requests
    // in flight (pendingCount). A transient limit like rate-limiting, so it
    // isn't persisted (the caller retries once something settles).
    for (const b of buckets) {
      if (b.maxConcurrent !== undefined && (b.pendingCount ?? 0) >= b.maxConcurrent) {
        return reject(
          `${b.dimension}_max_concurrent`,
          `Too many concurrent requests for ${b.dimension} "${b.value}" (max ${b.maxConcurrent})`,
          false
        );
      }
    }

    // Check all rates before consuming any. These transactional reads remain
    // in admission's read set, so concurrent requests cannot spend the same
    // capacity. Budget rejections below leave every rate balance untouched.
    for (const b of buckets) {
      const limit = b.requestsPerMinute;
      if (limit === undefined) continue;
      const ok = limit > 0 && (await requestRateLimiter.check(
        ctx, "requests", requestRateOptions(b)
      )).ok;
      if (!ok) {
        const code = b.dimension === USER_DIM ? "rate_limit" : `${b.dimension}_rate_limit`;
        return reject(
          code,
          `Rate limit exceeded for ${b.dimension} "${b.value}" (${limit}/min)`,
          false
        );
      }
    }

    // Committed + already-reserved in-flight usage + this estimate must fit
    // under EACH bucket's cap. Decided and reserved in one transaction, so
    // Convex's serializable isolation makes concurrent admission atomic across
    // every capped bucket. Final usage can exceed the estimate; settlement then
    // records the actual amount. Soft enforcement turns a violation into a
    // warning instead of a block.
    for (const b of buckets) {
      const sameDay = b.dayStamp === today;
      const sameMonth = b.monthStamp === month;
      const ev = evaluateCaps({
        label: b.dimension,
        name: b.value,
        enforcement: b.enforcement ?? "hard",
        warnAtPct: b.warnAtPct ?? defaultWarnAtPct,
        estCost: est.cost,
        estTokens: est.tokens,
        spendToday: sameDay ? b.spendTodayNanos : 0,
        reservedSpendToday: sameDay ? b.reservedTodayNanos ?? 0 : 0,
        spendThisMonth: sameMonth ? b.spendThisMonthNanos ?? 0 : 0,
        reservedSpendMonth: sameMonth ? b.reservedMonthNanos ?? 0 : 0,
        totalSpend: b.totalSpendNanos,
        reservedSpendTotal: b.reservedTotalNanos ?? 0,
        tokensToday: sameDay ? b.tokensToday ?? 0 : 0,
        reservedTokensToday: sameDay ? b.reservedTodayTokens ?? 0 : 0,
        tokensThisMonth: sameMonth ? b.tokensThisMonth ?? 0 : 0,
        reservedTokensMonth: sameMonth ? b.reservedMonthTokens ?? 0 : 0,
        totalTokens: b.totalTokens,
        reservedTokensTotal: b.reservedTotalTokens ?? 0,
        dailySpendLimitNanos: withBump(
          b.dailySpendLimitNanos,
          b.bumpDayStamp === today ? b.dailyBumpNanos : 0
        ),
        monthlySpendLimitNanos: withBump(
          b.monthlySpendLimitNanos,
          b.bumpMonthStamp === month ? b.monthlyBumpNanos : 0
        ),
        lifetimeSpendLimitNanos: withBump(
          b.lifetimeSpendLimitNanos,
          b.lifetimeBumpNanos
        ),
        dailyTokenLimit: b.dailyTokenLimit,
        monthlyTokenLimit: b.monthlyTokenLimit,
        lifetimeTokenLimit: b.lifetimeTokenLimit,
      });
      if (ev.hard) return reject(ev.hard.code, ev.hard.reason);
      warnings.push(...ev.warnings);
      notices.push(...ev.notices);
    }

    // Deployment-wide ("global") spend cap — the same estimated-usage admission
    // rule as the per-bucket caps above: a request is admitted only if
    // committed + reserved + estimate <= cap. The ONE difference is the holder:
    // per-bucket caps reserve on a single row (an atomic check-and-reserve),
    // while the global holder is a sharded counter for
    // throughput. The sum is transactional, but excludes unsettled usage and
    // has no cross-request reservation, so a hard global cap can overshoot. That's the deliberate consistency/throughput
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
        warnAtPct: defaultWarnAtPct,
        estCost: est.cost,
        estTokens: est.tokens,
        spendToday: await globalSpend.count(ctx, globalDayKey(today)),
        reservedSpendToday: 0, // sharded holder: no cross-request reservation
        spendThisMonth: 0, // global tracks daily + lifetime only
        reservedSpendMonth: 0,
        totalSpend: await globalSpend.count(ctx, GLOBAL_TOTAL),
        reservedSpendTotal: 0,
        tokensToday: 0,
        reservedTokensToday: 0,
        tokensThisMonth: 0,
        reservedTokensMonth: 0,
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
      notices.push(...globalEval.notices);
    }

    // Consume only after every admission check succeeds, in the same
    // transaction as the reservations and request insert. `throws: true` is
    // deliberate, not a rough edge: we already `.check`ed every bucket above in
    // this same serializable transaction, so a `.limit` here cannot fail on a
    // bucket that passed check — and if it somehow did (or a later bucket did),
    // throwing rolls back the WHOLE transaction, including the rate we already
    // consumed on earlier buckets. Converting this to a graceful `{allowed:false}`
    // return would COMMIT the partial consumption and leak rate capacity, so keep
    // the throw.
    for (const b of buckets) {
      if (b.requestsPerMinute !== undefined) {
        await requestRateLimiter.limit(ctx, "requests", {
          ...requestRateOptions(b),
          throws: true,
        });
      }
    }

    // Passed — reserve, but ONLY on buckets that actually have a cap. Writing an
    // uncapped bucket's row here would serialize every request that shares it
    // (e.g. all callers of one action, or every request in one env); with no cap
    // there's no reserved amount to consult. Totals are still accrued later,
    // asynchronously, in foldOne — for every bucket, capped or not.
    for (const b of buckets) {
      if (!needsReserve(b)) continue;
      const sameDay = b.dayStamp === today;
      const sameMonth = b.monthStamp === month;
      await ctx.db.patch(b._id, {
        dayStamp: today,
        monthStamp: month,
        spendTodayNanos: sameDay ? b.spendTodayNanos : 0,
        tokensToday: sameDay ? b.tokensToday ?? 0 : 0,
        spendThisMonthNanos: sameMonth ? b.spendThisMonthNanos ?? 0 : 0,
        tokensThisMonth: sameMonth ? b.tokensThisMonth ?? 0 : 0,
        reservedTodayNanos: (sameDay ? b.reservedTodayNanos ?? 0 : 0) + est.cost,
        reservedMonthNanos: (sameMonth ? b.reservedMonthNanos ?? 0 : 0) + est.cost,
        reservedTotalNanos: (b.reservedTotalNanos ?? 0) + est.cost,
        reservedTodayTokens: (sameDay ? b.reservedTodayTokens ?? 0 : 0) + est.tokens,
        reservedMonthTokens: (sameMonth ? b.reservedMonthTokens ?? 0 : 0) + est.tokens,
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
      ...(args.reserveTtlMs !== undefined ? { reserveTtlMs: args.reserveTtlMs } : {}),
      status: "pending",
      expiresAt: Date.now() + Math.max(STALE_PENDING_MS, args.reserveTtlMs ?? 0),
      heldBucketIds: buckets.filter(needsReserve).map(b => b._id),
      reservationDay: today,
      reservationMonth: month,
      estimatedNanos: est.cost,
      estimatedTokens: est.tokens,
      ...(priceInfo.known ? {} : { unpricedModel: true }),
      ...(warnings.length > 0 ? { overBudget: true } : {}),
    });
    // Reverse index so the request log can be filtered by any extra tag
    // dimension (user/action are already indexed on the requests table).
    for (const t of extraTags) {
      await ctx.db.insert("requestTags", {
        dimension: t.dimension,
        value: t.value,
        requestId,
      });
    }
    return { allowed: true as const, requestId, warnings, notices };
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
    // Provider server-tool invocations that bill a per-call fee (e.g.
    // { web_search: 3 }). Added to the token cost when no authoritative cost is
    // supplied; recorded either way.
    serverToolUses: v.optional(v.record(v.string(), v.number())),
    // Authoritative cost from the gateway/provider, if reported. When present
    // it's recorded verbatim (already includes any tool fees); when absent we
    // price from tokens (cache-aware) plus server-tool fees.
    costNanos: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
  },
  returns: v.object({ costNanos: v.number() }),
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    // The request may be gone — retention purged it, or the owning bucket was
    // deleted. A late/duplicate webhook must be an idempotent no-op, not a 500
    // (the caller can't do anything useful with the error, and it triggers retries).
    if (!request) return { costNanos: 0 };

    // Expiry releases capacity, but is not evidence that the provider charged
    // nothing. Accept one final result even after expiry; duplicates stay no-ops.
    if (request.status !== "pending" && !request.reservationExpired) {
      return { costNanos: request.costNanos ?? 0 };
    }

    // Coerce caller/provider-supplied token counts to finite nonnegative
    // integers: negatives would refund below a cap, and NaN/Infinity (which
    // v.number() allows) would poison every downstream total and cap check.
    const promptTokens = safeCount(args.promptTokens);
    const completionTokens = safeCount(args.completionTokens);
    const cachedTokens = Math.min(promptTokens, safeCount(args.cachedTokens));
    // Prefer an authoritative gateway cost when supplied (it already includes
    // tool fees); otherwise price from tokens — discounting the cached
    // (prompt-cache-read) slice — plus any server-tool per-call fees. Require it
    // finite: +Infinity passes a bare `>= 0` and would corrupt the totals.
    let costNanos: number;
    if (args.costNanos !== undefined && Number.isFinite(args.costNanos) && args.costNanos >= 0) {
      costNanos = Math.round(args.costNanos);
    } else {
      const settings = await getSettings(ctx);
      costNanos =
        settleCost(
          promptTokens,
          cachedTokens,
          completionTokens,
          await getPrice(ctx, request.model)
        ) + serverToolCost(args.serverToolUses, settings?.serverToolPrices);
    }

    // Durable write to the request's OWN row only — uncontended, so it always
    // lands. `settled: false` hands it to the fold step; the row is never left
    // orphaned in "pending" even if the totals update below fails and retries.
    await ctx.db.patch(args.requestId, {
      status: args.error ? "error" : "success",
      reservationExpired: false,
      expiresAt: undefined,
      finishedAt: Date.now(),
      responseText: args.responseText,
      error: args.error,
      promptTokens,
      completionTokens,
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
      ...(args.serverToolUses ? { serverToolUses: args.serverToolUses } : {}),
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

// Release only holds owned by this request, and only from their original
// calendar windows. A previous day's completion must not debit today's holds.
async function releaseReservation(ctx: MutationCtx, req: Doc<"requests">) {
  if (req.reservationReleased) return;
  const day = req.reservationDay ?? new Date(req._creationTime).toISOString().slice(0, 10);
  const month = req.reservationMonth ?? day.slice(0, 7);
  const cost = req.estimatedNanos ?? 0;
  const tokens = req.estimatedTokens ?? 0;
  for (const t of requestBuckets(req.userId, req.actionName, req.tags)) {
    const b = await getBucketDoc(ctx, t.dimension, t.value);
    if (!b || (req.heldBucketIds ? !req.heldBucketIds.includes(b._id) : !needsReserve(b))) continue;
    await ctx.db.patch(b._id, {
      reservedTodayNanos: Math.max(0, (b.reservedTodayNanos ?? 0) - (b.dayStamp === day ? cost : 0)),
      reservedMonthNanos: Math.max(0, (b.reservedMonthNanos ?? 0) - (b.monthStamp === month ? cost : 0)),
      reservedTotalNanos: Math.max(0, (b.reservedTotalNanos ?? 0) - cost),
      reservedTodayTokens: Math.max(0, (b.reservedTodayTokens ?? 0) - (b.dayStamp === day ? tokens : 0)),
      reservedMonthTokens: Math.max(0, (b.reservedMonthTokens ?? 0) - (b.monthStamp === month ? tokens : 0)),
      reservedTotalTokens: Math.max(0, (b.reservedTotalTokens ?? 0) - tokens),
      pendingCount: Math.max(0, (b.pendingCount ?? 0) - 1),
    });
  }
  await ctx.db.patch(req._id, { reservationReleased: true });
}

// Final billing is folded once. Reservation release has its own guard because
// expiry can precede the final charge by hours or days.
async function foldOne(ctx: MutationCtx, req: Doc<"requests"> | null) {
  if (!req || req.settled !== false) return;
  await releaseReservation(ctx, req);
  const actual = req.costNanos ?? 0;
  const tokens = (req.promptTokens ?? 0) + (req.completionTokens ?? 0);
  const timestamp = new Date(req.finishedAt ?? Date.now()).toISOString();
  const day = timestamp.slice(0, 10);
  const month = timestamp.slice(0, 7);
  for (const t of requestBuckets(req.userId, req.actionName, req.tags)) {
    const b = await getOrCreateBucket(ctx, t.dimension, t.value);
    // Keep the newest reporting window and clear obsolete window holds when
    // advancing it. Lifetime holds persist until their owner releases them.
    const targetDay = b.dayStamp > day ? b.dayStamp : day;
    const targetMonth = (b.monthStamp ?? "") > month ? b.monthStamp! : month;
    await ctx.db.patch(b._id, {
      totalSpendNanos: b.totalSpendNanos + actual,
      totalRequests: b.totalRequests + 1,
      totalTokens: b.totalTokens + tokens,
      dayStamp: targetDay,
      monthStamp: targetMonth,
      spendTodayNanos: (b.dayStamp === targetDay ? b.spendTodayNanos : 0) + (day === targetDay ? actual : 0),
      tokensToday: (b.dayStamp === targetDay ? b.tokensToday ?? 0 : 0) + (day === targetDay ? tokens : 0),
      spendThisMonthNanos: (b.monthStamp === targetMonth ? b.spendThisMonthNanos ?? 0 : 0) + (month === targetMonth ? actual : 0),
      tokensThisMonth: (b.monthStamp === targetMonth ? b.tokensThisMonth ?? 0 : 0) + (month === targetMonth ? tokens : 0),
      ...(b.dayStamp !== targetDay ? { reservedTodayNanos: 0, reservedTodayTokens: 0 } : {}),
      ...(b.monthStamp !== targetMonth ? { reservedMonthNanos: 0, reservedMonthTokens: 0 } : {}),
    });
    await addUsage(ctx, t.dimension, t.value, "day", day, actual, tokens, 1);
    await addUsage(ctx, t.dimension, t.value, "month", month, actual, tokens, 1);
  }
  // Reporting is independent of whether enforcement is configured.
  if (actual > 0) {
    await globalSpend.add(ctx, GLOBAL_TOTAL, actual);
    await globalSpend.add(ctx, globalDayKey(day), actual);
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

    // Lazily migrate old pending rows in bounded batches. Once indexed, long
    // TTL jobs cannot hide expired jobs behind them in creation-time order.
    const legacy = await ctx.db.query("requests").withIndex("status_expires", q =>
      q.eq("status", "pending").eq("expiresAt", undefined)).take(200);
    for (const req of legacy) {
      await ctx.db.patch(req._id, { expiresAt: req._creationTime + Math.max(STALE_PENDING_MS, req.reserveTtlMs ?? 0) });
    }
    const candidates = await ctx.db.query("requests").withIndex("status_expires", q =>
      q.eq("status", "pending").gt("expiresAt", 0).lte("expiresAt", Date.now())).take(200);
    for (const req of candidates) {
      await releaseReservation(ctx, req);
      await ctx.db.patch(req._id, {
        status: "error", error: "Reservation expired; awaiting final usage",
        reservationExpired: true, expiresAt: undefined, settled: true,
      });
    }
    const expired = candidates.length;

    // Retention: delete terminal, fully-accounted request rows past the window.
    const settings = await getSettings(ctx);
    const retentionMs = settings?.retentionMs ?? DEFAULT_RETENTION_MS;
    let purged = 0;
    if (retentionMs > 0) {
      const retentionCutoff = Date.now() - retentionMs;
      // Query eligible states directly. Long-lived pending jobs and expired
      // billing tombstones must not repeatedly occupy the front of a scan.
      const old = [];
      for (const expiredFlag of [undefined, false]) {
        old.push(...await ctx.db.query("requests").withIndex("retention", q =>
          q.eq("reservationExpired", expiredFlag).eq("settled", true)
            .lt("_creationTime", retentionCutoff)).take(200));
      }
      old.push(...await ctx.db.query("requests").withIndex("status", q =>
        q.eq("status", "blocked").lt("_creationTime", retentionCutoff)).take(100));
      for (const req of old) {
        await deleteRequestTags(ctx, req._id);
        await ctx.db.delete(req._id);
        purged++;
      }
      const expiredContent = await ctx.db.query("requests").withIndex("expired_content", q =>
        q.eq("reservationExpired", true).eq("contentPurged", undefined)
          .lt("_creationTime", retentionCutoff)).take(200);
      for (const req of expiredContent) {
        await ctx.db.patch(req._id, { messages: [], responseText: undefined, contentPurged: true });
      }
    }
    return { folded: toFold.length, expired, purged };
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
  args: {
    userId: v.optional(v.string()),
    // Filter by any attribution dimension (user/action indexed on the request;
    // custom tag dimensions resolved via the requestTags reverse index).
    dimension: v.optional(v.string()),
    value: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const dim = args.dimension;
    const val = args.value ?? args.userId;
    if (dim === undefined && args.userId !== undefined) {
      const userId = args.userId;
      return await ctx.db
        .query("requests")
        .withIndex("userId", (q) => q.eq("userId", userId))
        .order("desc")
        .take(limit);
    }
    if (dim !== undefined && val !== undefined) {
      if (dim === USER_DIM) {
        return await ctx.db
          .query("requests")
          .withIndex("userId", (q) => q.eq("userId", val))
          .order("desc")
          .take(limit);
      }
      if (dim === ACTION_DIM) {
        return await ctx.db
          .query("requests")
          .withIndex("actionName", (q) => q.eq("actionName", val))
          .order("desc")
          .take(limit);
      }
      // Custom tag dimension: walk the reverse index, then fetch each request.
      const tagRows = await ctx.db
        .query("requestTags")
        .withIndex("dim_value", (q) => q.eq("dimension", dim).eq("value", val))
        .order("desc")
        .take(limit);
      const rows = await Promise.all(tagRows.map((t) => ctx.db.get(t.requestId)));
      return rows.filter((r): r is Doc<"requests"> => r !== null);
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
    const month = monthStamp();
    return rows.map((b) => ({
      ...b,
      spendTodayNanos: b.dayStamp === today ? b.spendTodayNanos : 0,
      spendThisMonthNanos: b.monthStamp === month ? b.spendThisMonthNanos ?? 0 : 0,
    }));
  },
});

export const getBucket = query({
  args: { dimension: v.string(), value: v.string() },
  handler: async (ctx, args) => {
    const b = await getBucketDoc(ctx as any, args.dimension, args.value);
    if (!b) return null;
    const today = dayStamp();
    const month = monthStamp();
    return {
      ...b,
      spendTodayNanos: b.dayStamp === today ? b.spendTodayNanos : 0,
      spendThisMonthNanos: b.monthStamp === month ? b.spendThisMonthNanos ?? 0 : 0,
    };
  },
});

// Set a bucket's limits/controls. `user` and `action` are just dimensions here;
// the client's ai.users / ai.actions namespaces are thin wrappers over this.
export const setBucketLimits = mutation({
  args: {
    dimension: v.string(),
    value: v.string(),
    requestsPerMinute: v.optional(v.number()),
    maxConcurrent: v.optional(v.number()),
    dailySpendLimitNanos: v.optional(v.number()),
    monthlySpendLimitNanos: v.optional(v.number()),
    lifetimeSpendLimitNanos: v.optional(v.number()),
    dailyTokenLimit: v.optional(v.number()),
    monthlyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    warnAtPct: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
    blocked: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertAmount(args.requestsPerMinute, "requestsPerMinute");
    assertAmount(args.maxConcurrent, "maxConcurrent");
    assertAmount(args.dailySpendLimitNanos, "dailySpendLimitNanos");
    assertAmount(args.monthlySpendLimitNanos, "monthlySpendLimitNanos");
    assertAmount(args.lifetimeSpendLimitNanos, "lifetimeSpendLimitNanos");
    assertAmount(args.dailyTokenLimit, "dailyTokenLimit");
    assertAmount(args.monthlyTokenLimit, "monthlyTokenLimit");
    assertAmount(args.lifetimeTokenLimit, "lifetimeTokenLimit");
    assertFraction(args.warnAtPct, "warnAtPct");
    const bucket = await getOrCreateBucket(ctx, args.dimension, args.value);
    const { dimension: _d, value: _v, ...limits } = args;
    await ctx.db.patch(bucket._id, limits);
    await syncPolicy(ctx, (await ctx.db.get(bucket._id))!);
    return null;
  },
});

const vBumpArgs = {
  dailyNanos: v.optional(v.number()),
  monthlyNanos: v.optional(v.number()),
  lifetimeNanos: v.optional(v.number()),
};

// One-time "approve another $X" bumps, added on top of a bucket's standing cap
// without changing it. Daily/monthly bumps apply to the current window only;
// lifetime bumps persist.
export const bumpBucket = mutation({
  args: { dimension: v.string(), value: v.string(), ...vBumpArgs },
  returns: v.null(),
  handler: async (ctx, { dimension, value, dailyNanos, monthlyNanos, lifetimeNanos }) => {
    assertAmount(dailyNanos, "dailyNanos");
    assertAmount(monthlyNanos, "monthlyNanos");
    assertAmount(lifetimeNanos, "lifetimeNanos");
    const bucket = await getOrCreateBucket(ctx, dimension, value);
    const today = dayStamp();
    const month = monthStamp();
    const curDaily =
      bucket.bumpDayStamp === today ? bucket.dailyBumpNanos ?? 0 : 0;
    const curMonthly =
      bucket.bumpMonthStamp === month ? bucket.monthlyBumpNanos ?? 0 : 0;
    await ctx.db.patch(bucket._id, {
      bumpDayStamp: today,
      dailyBumpNanos: curDaily + (dailyNanos ?? 0),
      bumpMonthStamp: month,
      monthlyBumpNanos: curMonthly + (monthlyNanos ?? 0),
      lifetimeBumpNanos: (bucket.lifetimeBumpNanos ?? 0) + (lifetimeNanos ?? 0),
    });
    return null;
  },
});

// Manually credit or debit a bucket (comp a user, correct an overcharge).
// Negative deltaNanos = credit/refund, positive = extra charge. Adjusts the
// live day/month/lifetime windows AND the durable usage history, and records an
// audit row. Does not touch the global sharded total or reservations.
export const adjustBucket = mutation({
  args: {
    dimension: v.string(),
    value: v.string(),
    deltaNanos: v.number(),
    tokens: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { dimension, value, deltaNanos, tokens, reason }) => {
    assertAmount(deltaNanos, "deltaNanos", { signed: true });
    assertAmount(tokens, "tokens", { signed: true });
    const b = await getOrCreateBucket(ctx, dimension, value);
    const today = dayStamp();
    const month = monthStamp();
    const dSame = b.dayStamp === today;
    const mSame = b.monthStamp === month;
    const dt = tokens ?? 0;
    await ctx.db.patch(b._id, {
      totalSpendNanos: Math.max(0, b.totalSpendNanos + deltaNanos),
      totalTokens: Math.max(0, b.totalTokens + dt),
      dayStamp: today,
      monthStamp: month,
      spendTodayNanos: Math.max(0, (dSame ? b.spendTodayNanos : 0) + deltaNanos),
      tokensToday: Math.max(0, (dSame ? b.tokensToday ?? 0 : 0) + dt),
      spendThisMonthNanos: Math.max(0, (mSame ? b.spendThisMonthNanos ?? 0 : 0) + deltaNanos),
      tokensThisMonth: Math.max(0, (mSame ? b.tokensThisMonth ?? 0 : 0) + dt),
      // Advancing the window here must also clear the OLD window's reserved
      // holds, or an in-flight request from the previous day/month would be
      // treated as reserving against the new window and its later release would
      // no longer match — stranding those reserved nanos/tokens.
      ...(dSame ? {} : { reservedTodayNanos: 0, reservedTodayTokens: 0 }),
      ...(mSame ? {} : { reservedMonthNanos: 0, reservedMonthTokens: 0 }),
    });
    await ctx.db.insert("adjustments", { dimension, value, deltaNanos, tokens: dt, reason });
    await addUsage(ctx, dimension, value, "day", today, deltaNanos, dt, 0);
    await addUsage(ctx, dimension, value, "month", month, deltaNanos, dt, 0);
    return null;
  },
});

export const listAdjustments = query({
  args: { dimension: v.string(), value: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { dimension, value, limit }) =>
    ctx.db
      .query("adjustments")
      .withIndex("dim_value", (q) => q.eq("dimension", dimension).eq("value", value))
      .order("desc")
      .take(limit ?? 50),
});

// Durable spend history for a bucket: per-day or per-month rows, newest first.
// Survives request retention.
export const usageHistory = query({
  args: {
    dimension: v.string(),
    value: v.string(),
    period: v.union(v.literal("day"), v.literal("month")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { dimension, value, period, limit }) =>
    ctx.db
      .query("usage")
      .withIndex("bucket_period_stamp", (q) =>
        q.eq("dimension", dimension).eq("value", value).eq("period", period)
      )
      .order("desc")
      .take(limit ?? 90),
});

// Deployment-wide default threshold for approaching-limit alerts (fraction of a
// cap, e.g. 0.8). Buckets can override with their own warnAtPct.
export const setAlertDefaults = mutation({
  args: { warnAtPct: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { warnAtPct }) => {
    const existing = await getSettings(ctx);
    if (existing) await ctx.db.patch(existing._id, { defaultWarnAtPct: warnAtPct });
    else await ctx.db.insert("settings", { key: "singleton", defaultWarnAtPct: warnAtPct });
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
      for (const r of rows) {
        // Before dropping the row, free or settle any hold it placed on OTHER
        // (shared) buckets — an action/customer bucket this user's request
        // reserved against. Otherwise deleting the only row that could release
        // that hold strands the shared bucket's reservation + pendingCount
        // forever, and a late finish would throw. A finished-but-unfolded row
        // is folded (the charge lands on the shared buckets); a still-pending
        // one just has its reservation released.
        if (r.settled === false) await foldOne(ctx, r);
        else if (r.status === "pending") await releaseReservation(ctx, r);
        await deleteRequestTags(ctx, r._id);
        await ctx.db.delete(r._id);
      }
      if (rows.length === DELETE_BATCH) {
        await ctx.scheduler.runAfter(0, api.lib.deleteBucket, {
          dimension,
          value,
        });
        return { deletedThisBatch: rows.length, done: false };
      }
      const bucket = await getBucketDoc(ctx, dimension, value);
      if (bucket) {
        const policy = await ctx.db.query("bucketPolicies").withIndex("dim_value", q =>
          q.eq("dimension", dimension).eq("value", value)).unique();
        if (policy) await ctx.db.delete(policy._id);
        await requestRateLimiter.reset(ctx, "requests", { key: bucket._id });
        await ctx.db.delete(bucket._id);
      }
      return { deletedThisBatch: rows.length + (bucket ? 1 : 0), done: true };
    }
    const bucket = await getBucketDoc(ctx, dimension, value);
    if (bucket) {
      const policy = await ctx.db.query("bucketPolicies").withIndex("dim_value", q =>
          q.eq("dimension", dimension).eq("value", value)).unique();
        if (policy) await ctx.db.delete(policy._id);
        await requestRateLimiter.reset(ctx, "requests", { key: bucket._id });
      await ctx.db.delete(bucket._id);
    }
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
    // deployment-wide config (surfaced for the admin dashboard)
    retentionMs: v.union(v.number(), v.null()),
    defaultWarnAtPct: v.union(v.number(), v.null()),
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
      retentionMs: s?.retentionMs ?? null,
      defaultWarnAtPct: s?.defaultWarnAtPct ?? null,
    };
  },
});

export const setGlobalLimits = mutation({
  args: {
    // Absent = leave unchanged; explicit null = clear that limit. (A bare
    // v.optional(number) that always rebuilt the full patch would let a
    // one-field edit — exactly what the dashboard sends — silently wipe the
    // other global controls by patching them to undefined.)
    dailySpendLimitNanos: v.optional(v.union(v.number(), v.null())),
    lifetimeSpendLimitNanos: v.optional(v.union(v.number(), v.null())),
    enforcement: v.optional(
      v.union(v.literal("hard"), v.literal("soft"), v.null())
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (typeof args.dailySpendLimitNanos === "number")
      assertAmount(args.dailySpendLimitNanos, "dailySpendLimitNanos");
    if (typeof args.lifetimeSpendLimitNanos === "number")
      assertAmount(args.lifetimeSpendLimitNanos, "lifetimeSpendLimitNanos");
    // The settings fields are "global"-prefixed; map the friendly arg names,
    // touching ONLY the keys the caller actually passed. null -> clear.
    const patch: Record<string, unknown> = {};
    if ("dailySpendLimitNanos" in args)
      patch.globalDailySpendLimitNanos = args.dailySpendLimitNanos ?? undefined;
    if ("lifetimeSpendLimitNanos" in args)
      patch.globalLifetimeSpendLimitNanos = args.lifetimeSpendLimitNanos ?? undefined;
    if ("enforcement" in args)
      patch.globalEnforcement = args.enforcement ?? undefined;
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
    // optional cache-read rate; if omitted, a default discount off input applies
    cachedNanosPerMTok: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Negative prices would make costOf return a negative cost, which folds
    // into totals as a spend *refund* — pushing a user back under their cap.
    // NaN/Infinity (allowed by v.number()) are just as corrupting — a NaN rate
    // poisons every settled cost for the model — so require finite integers.
    assertAmount(args.inputNanosPerMTok, "inputNanosPerMTok");
    assertAmount(args.outputNanosPerMTok, "outputNanosPerMTok");
    assertAmount(args.cachedNanosPerMTok, "cachedNanosPerMTok");
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
    const merged: Record<
      string,
      { input: number; output: number; cached?: number; overridden: boolean }
    > = {};
    for (const [model, p] of Object.entries(DEFAULT_PRICES)) {
      merged[model] = { ...p, overridden: false };
    }
    for (const o of overrides) {
      merged[o.model] = {
        input: o.inputNanosPerMTok,
        output: o.outputNanosPerMTok,
        cached: o.cachedNanosPerMTok,
        overridden: true,
      };
    }
    return merged;
  },
});

// Per-call fees for provider server tools (web search, etc.), defaults merged
// with any deployment overrides.
export const listServerToolPrices = query({
  args: {},
  handler: async (ctx) => {
    const s = await getSettings(ctx as any);
    return { ...DEFAULT_SERVER_TOOL_PRICES, ...(s?.serverToolPrices ?? {}) };
  },
});

export const setServerToolPrice = mutation({
  args: { tool: v.string(), nanosPerCall: v.number() },
  returns: v.null(),
  handler: async (ctx, { tool, nanosPerCall }) => {
    if (nanosPerCall < 0) throw new Error("Prices must be non-negative");
    const s = await getSettings(ctx);
    const serverToolPrices = { ...(s?.serverToolPrices ?? {}), [tool]: nanosPerCall };
    if (s) await ctx.db.patch(s._id, { serverToolPrices });
    else await ctx.db.insert("settings", { key: "singleton", serverToolPrices });
    return null;
  },
});
