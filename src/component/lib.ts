import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { ShardedCounter } from "@convex-dev/sharded-counter";
import { paginator } from "convex-helpers/server/pagination";
import { paginationOptsValidator } from "convex/server";
import { type Infer, v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  internalMutation,
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server.js";
import schema, { vMessage, vTag } from "./schema.js";

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
  n: number | null | undefined,
  name: string,
  { signed = false }: { signed?: boolean; } = {},
) {
  if (n == null) return;
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new Error(`${name} must be a finite safe integer (got ${n})`);
  }
  if (!signed && n < 0) throw new Error(`${name} must be nonnegative (got ${n})`);
}
function assertFraction(n: number | null | undefined, name: string) {
  if (n == null) return;
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${name} must be a number in [0, 1] (got ${n})`);
  }
}
// Reject overflow at the write boundary; never silently lose financial precision.
// `saturate` is for the settle/reconcile hot path ONLY. There, a running total
// (lifetime spend/tokens) crossing 2^53 (~$9.007M on one bucket) would make
// assertAmount throw, roll back the fold batch, and make foldPhase retry it
// forever — wedging the reconciler deployment-wide. On that path we clamp at the
// safe-integer ceiling (loudly) so accounting keeps flowing; totals past the
// ceiling go approximate. Admin paths DON'T saturate — overflow there is a user
// action that must fail closed. (A true fix is int64/BigInt-backed totals.)
function checkedAccounting<T extends Record<string, unknown>>(
  fields: T,
  opts?: { saturate?: boolean; },
): T {
  for (const [key, value] of Object.entries(fields)) {
    if (
      typeof value === "number" && key !== "warnAtPct" && key !== "defaultWarnAtPct"
      && !key.endsWith("At")
    ) {
      if (opts?.saturate) {
        if (!Number.isFinite(value)) {
          throw new Error(`${key} must be a finite number (got ${value})`);
        }
        if (!Number.isSafeInteger(value)) {
          const clamped = value < 0 ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
          console.warn(
            `ai-budget: ${key} overflowed the safe-integer range (${value}); `
              + `saturating at ${clamped}. Totals past ~$9M on one bucket are approximate.`,
          );
          (fields as Record<string, number>)[key] = clamped;
        }
      } else {
        assertAmount(value, key, { signed: true });
      }
    }
  }
  return fields;
}
const pageSize = (n: number | undefined, fallback: number, max = 200) => {
  if (n !== undefined) assertAmount(n, "limit");
  return Math.min(Math.max(1, n ?? fallback), max);
};
// All mutations advancing a window must expire its credits along with its holds.
function windowResets(b: Doc<"buckets">, day: string, month: string) {
  return {
    ...(b.dayStamp === day ? {} : {
      creditsTodayNanos: 0,
      reservedTodayNanos: 0,
      reservedTodayTokens: 0,
    }),
    ...(b.monthStamp === month ? {} : {
      creditsThisMonthNanos: 0,
      reservedMonthNanos: 0,
      reservedMonthTokens: 0,
    }),
  };
}
function normalizedBucket(b: Doc<"buckets">, day: string, month: string) {
  return {
    ...b,
    ...windowResets(b, day, month),
    spendTodayNanos: b.dayStamp === day ? b.spendTodayNanos : 0,
    tokensToday: b.dayStamp === day ? b.tokensToday ?? 0 : 0,
    spendThisMonthNanos: b.monthStamp === month ? b.spendThisMonthNanos ?? 0 : 0,
    tokensThisMonth: b.monthStamp === month ? b.tokensThisMonth ?? 0 : 0,
  };
}
// Coerce a caller/provider-supplied count to a finite nonnegative integer,
// mapping NaN/Infinity/garbage to 0 rather than poisoning downstream totals.
const safeCount = (n: number | undefined) =>
  Number.isFinite(n)
    ? (() => {
      const value = Math.max(0, Math.floor(n as number));
      assertAmount(value, "token count");
      return value;
    })()
    : 0;
// Treat a non-finite stored accounting field as 0, so a bucket that was poisoned
// before validation existed self-heals on its next reserve/release instead of
// staying NaN forever.
const fin = (n: number | undefined) => (Number.isFinite(n) ? (n as number) : 0);

// Byte-limit guards. A `requests` row stores caller-controlled prompt/response
// content; Convex caps a document at 1 MiB and a transaction read at ~8 MiB /
// 16,384 docs. Cap what we STORE (not what we estimate from) so one big prompt
// can't fail the insert, and so reconcile/retention/delete scans that read full
// rows stay well under the transaction read limit.
const MAX_MSG_CONTENT = 8 * 1024; // per message
const MAX_STORED_MESSAGES_BYTES = 16 * 1024; // total across a row's messages
const MAX_STORED_RESPONSE_BYTES = 16 * 1024;
const MAX_STORED_MESSAGES = 48; // keep the most recent N
const MAX_TAGS = 16; // extra attribution dimensions per request
const MAX_SERVER_TOOLS = 32; // distinct server-tool keys per settle
const MAX_REASON = 2 * 1024; // adjustment reason, bytes
const MAX_AUDIT_DETAILS = 8 * 1024; // serialized admin-event details, bytes
const MAX_MODELS = 1000; // model allow/deny-list entries
const MAX_MODEL_LEN = 256; // per model-id length, chars

const encoder = new TextEncoder();
const truncate = (s: string, n: number) => {
  const bytes = encoder.encode(s);
  if (bytes.length <= n) return s;
  const suffix = "…[truncated]";
  const suffixBytes = encoder.encode(suffix).length;
  if (n <= suffixBytes) return new TextDecoder().decode(bytes.slice(0, Math.max(0, n - 3)));
  return new TextDecoder().decode(bytes.slice(0, Math.max(0, n - suffixBytes - 3))) + suffix;
};
function assertKey(value: string, name: string, max = 256) {
  if (!value || encoder.encode(value).length > max) {
    throw new Error(`${name} must contain 1–${max} UTF-8 bytes`);
  }
}

// Cap prompt content for STORAGE: keep the most recent messages, cap each and
// the total. The token estimate still uses the full (uncapped) prompt.
function capMessages(
  messages: { role: string; content: string; }[],
): { role: string; content: string; }[] {
  const recent = messages.slice(-MAX_STORED_MESSAGES);
  const out: { role: string; content: string; }[] = [];
  let total = 0;
  for (const m of recent) {
    if (total >= MAX_STORED_MESSAGES_BYTES) break;
    const raw = typeof m.content === "string" ? m.content : String(m.content ?? "");
    const room = Math.min(MAX_MSG_CONTENT, MAX_STORED_MESSAGES_BYTES - total);
    const content = truncate(raw, room);
    total += encoder.encode(content).length;
    out.push({ role: truncate(String(m.role), 32), content });
  }
  return out;
}
const capResponse = (s: string | undefined) =>
  s === undefined ? undefined : truncate(s, MAX_STORED_RESPONSE_BYTES);
// Bound the server-tool record stored on the row (its keys are caller-supplied).
function boundServerTools(
  uses: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  let n = 0;
  for (const [k, v] of Object.entries(uses)) {
    if (n >= MAX_SERVER_TOOLS) break;
    out[k.slice(0, 64)] = safeCount(v);
    n++;
  }
  return out;
}

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
const DEFAULT_PRICES: Record<string, { input: number; output: number; }> = {
  "anthropic/claude-opus-5": { input: 15_000_000_000, output: 75_000_000_000 },
  "anthropic/claude-sonnet-5": { input: 3_000_000_000, output: 15_000_000_000 },
  "anthropic/claude-sonnet-4.5": { input: 3_000_000_000, output: 15_000_000_000 },
  "anthropic/claude-haiku-4.5": { input: 1_000_000_000, output: 5_000_000_000 },
  "openai/gpt-4o": { input: 2_500_000_000, output: 10_000_000_000 },
  "openai/gpt-4o-mini": { input: 150_000_000, output: 600_000_000 },
  "openai/gpt-5": { input: 1_250_000_000, output: 10_000_000_000 },
  "openai/gpt-5-mini": { input: 250_000_000, output: 2_000_000_000 },
  // The Decisions ("Jev") endpoint used by ai.decisions.
  "typesafe/jev-1.13": { input: 1_000_000_000, output: 5_000_000_000 },
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
// Reconciliation runs as small, independently-rescheduling phases. Keeping the
// batch small bounds the bytes read per transaction (each request row can carry
// prompts/responses) so a burst can't push one phase past Convex's 8 MiB / 16k-
// doc read limit and stall the whole reconciler. A phase that fills its batch
// reschedules itself immediately, so throughput still scales with backlog.
// Small enough that even retentionPhase's several full-row scans in one
// transaction stay well under the ~8 MiB read limit (rows carry capped content).
const RECONCILE_BATCH = 25;
// Keep an expired billing tombstone (content already purged) this long so a very
// late provider charge can still land against it, then delete it. A finish after
// deletion is a graceful no-op.
const LATE_SETTLE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const dayStamp = () => new Date().toISOString().slice(0, 10); // "2026-09-04"
const monthStamp = () => new Date().toISOString().slice(0, 7); // "2026-09"

// Cached (prompt-cache-read) input tokens are billed far below the normal input
// rate. When a model's price has no explicit cachedNanosPerMTok, charge this
// fraction of its input rate (providers commonly discount ~90%).
const CACHE_DISCOUNT = 0.1;

// Conservative fallback for any model not in the price table: the most expensive
// model we DO know (frontier / Opus-class). Falling back to 0 would be fail-open
// — an unpriced model would reserve 0, pass every cap, and log 0¢ while the AI
// Gateway still bills real money. Charging the frontier rate instead keeps caps
// honest (over-counting is the safe direction) WITHOUT the old arbitrary
// $20/$100 ceiling, which over-reserved so hard it could block a second
// concurrent turn under a small cap. Admins pin an exact rate with setPrice;
// gateway calls still settle at the authoritative cost regardless.
const CONSERVATIVE_PRICE = Object.values(DEFAULT_PRICES).reduce(
  (m, p) => ({
    input: Math.max(m.input, p.input),
    output: Math.max(m.output, p.output),
  }),
  { input: 0, output: 0 },
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
      cacheWrite: override.cacheWriteNanosPerMTok,
      cacheWrite1h: override.cacheWrite1hNanosPerMTok,
      known: true,
    };
  }
  const known = DEFAULT_PRICES[model];
  if (known) {
    return {
      ...known,
      cached: undefined,
      cacheWrite: undefined,
      cacheWrite1h: undefined,
      known: true,
    };
  }
  return {
    ...CONSERVATIVE_PRICE,
    cached: undefined,
    cacheWrite: undefined,
    cacheWrite1h: undefined,
    known: false,
  };
}

type Price = {
  input: number;
  output: number;
  cached?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
};
// The per-Mtok rate for cached (prompt-cache-read) tokens: an explicit override,
// else a discount off the input rate.
const cachedRate = (p: Price) => p.cached ?? Math.round(p.input * CACHE_DISCOUNT);

// Keep intermediates exact even when token counts × rates exceed 2^53.
function tokenCost(parts: [number, number][]) {
  let numerator = 0n;
  for (const [tokens, rate] of parts) {
    assertAmount(tokens, "tokens");
    assertAmount(rate, "token rate");
    numerator += BigInt(tokens) * BigInt(rate);
  }
  const cost = Number((numerator + 500_000n) / 1_000_000n);
  assertAmount(cost, "token cost");
  return cost;
}
const costOf = (
  inputTokens: number,
  outputTokens: number,
  price: { input: number; output: number; },
) => tokenCost([[inputTokens, price.input], [outputTokens, price.output]]);

// Cache-aware settle cost: the cached slice of the prompt is billed at the
// (discounted) cache rate, the rest of the prompt at the input rate, and
// completions at the output rate. `cachedTokens` is the gateway's real
// prompt-cache-read count (usage.inputTokenDetails.cacheReadTokens).
const settleCost = (
  promptTokens: number,
  cachedTokens: number,
  completionTokens: number,
  price: Price,
  cachedWriteTokens = 0,
  cachedWrite1hTokens = 0,
) => {
  const cached = Math.min(Math.max(0, cachedTokens), Math.max(0, promptTokens));
  const written = Math.min(Math.max(0, cachedWriteTokens), Math.max(0, promptTokens - cached));
  const written1h = Math.min(written, cachedWrite1hTokens);
  const fresh = Math.max(0, promptTokens - cached - written);
  return tokenCost([
    [fresh, price.input],
    [cached, cachedRate(price)],
    [written - written1h, price.cacheWrite ?? Math.round(price.input * 1.25)],
    [written1h, price.cacheWrite1h ?? price.input * 2],
    [completionTokens, price.output],
  ]);
};

// Per-call fees for provider server tools (web search, etc.), merging the
// defaults with any deployment overrides. Unknown tools price at 0 (recorded
// but not charged) rather than guessing.
const serverToolCost = (
  uses: Record<string, number> | undefined,
  overrides: Record<string, number> | undefined,
) => {
  if (!uses) return 0;
  const prices = { ...DEFAULT_SERVER_TOOL_PRICES, ...(overrides ?? {}) };
  let total = 0n;
  for (const [tool, count] of Object.entries(uses)) {
    assertAmount(count, `serverToolUses.${tool}`);
    // count is an asserted integer; round the (possibly default) price so BigInt
    // can't throw on a fractional nanodollar rate.
    if (count > 0 && prices[tool] > 0) total += BigInt(count) * BigInt(Math.round(prices[tool]));
  }
  const result = Number(total);
  assertAmount(result, "server-tool cost");
  return result;
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
  requests: number,
) {
  const existing = await ctx.db
    .query("usage")
    .withIndex("bucket_period_stamp", (q) =>
      q
        .eq("dimension", dimension)
        .eq("value", value)
        .eq("period", period)
        .eq("stamp", stamp))
    .unique();
  if (existing) {
    await ctx.db.patch(
      existing._id,
      checkedAccounting({
        spendNanos: existing.spendNanos + spendNanos,
        tokens: existing.tokens + tokens,
        requests: existing.requests + requests,
      }),
    );
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
  messages: { content: string; }[],
  price: { input: number; output: number; },
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
  extra: { dimension: string; value: string; }[] | undefined,
): { dimension: string; value: string; }[] {
  const out = [{ dimension: USER_DIM, value: userId }];
  if (actionName !== undefined) {
    out.push({ dimension: ACTION_DIM, value: actionName });
  }
  for (const t of extra ?? []) {
    if (t.dimension === USER_DIM || t.dimension === ACTION_DIM) continue;
    if (!t.dimension || !t.value) continue;
    if (out.some((x) => x.dimension === t.dimension && x.value === t.value)) {
      continue;
    }
    out.push({ dimension: t.dimension, value: t.value });
  }
  return out;
}

// Drop reserved/empty/duplicate tags from a caller-supplied list, leaving the
// "extra" dimensions stored on the request row.
function sanitizeExtraTags(
  extra: { dimension: string; value: string; }[] | undefined,
): { dimension: string; value: string; }[] {
  const out: { dimension: string; value: string; }[] = [];
  for (const t of extra ?? []) {
    if (t.dimension === USER_DIM || t.dimension === ACTION_DIM) continue;
    if (!t.dimension || !t.value) continue;
    if (out.some((x) => x.dimension === t.dimension && x.value === t.value)) {
      continue;
    }
    assertKey(t.dimension, "tag dimension", 64);
    assertKey(t.value, "tag value");
    out.push({ dimension: t.dimension, value: t.value });
    // Bound per-request fan-out: each extra tag becomes a bucket read/patch, a
    // requestTags insert, and a reservation. An unbounded list would blow the
    // mutation's document write/read limits and wedge the call.
    if (out.length > MAX_TAGS) throw new Error(`At most ${MAX_TAGS} attribution tags are allowed`);
  }
  return out;
}

// Evaluate a bucket's spend + token budgets against committed + reserved + this
// request's estimate. Returns a hard rejection (block), soft warnings (allow),
// and threshold notices (approaching a cap — see warnAtPct). Each window (daily,
// monthly, lifetime) × kind (spend, token) is one check.
const projected = (...amounts: number[]) =>
  amounts.reduce((sum, amount) => {
    assertAmount(amount, "budget usage", { signed: true });
    return sum + BigInt(amount);
  }, 0n);

function evaluateCaps(o: {
  label: string;
  name: string;
  // "approximate" is the global killswitch mode; it blocks like "hard" here.
  enforcement: "hard" | "soft" | "approximate";
  warnAtPct?: number;
  estCost: number;
  estTokens: number;
  spendToday: number;
  reservedSpendToday: number;
  spendThisMonth: number;
  reservedSpendMonth: number;
  totalSpend: number;
  reservedSpendTotal: number;
  // Manual credits (subtracted from spend so a credit grants headroom).
  creditsToday?: number;
  creditsThisMonth?: number;
  creditsTotal?: number;
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
  hard?: { code: string; reason: string; };
  warnings: string[];
  notices: string[];
} {
  // { code, projected usage (incl. this estimate), cap, human window label,
  //   whether it's a money cap (formatted as $), spend? for notices }
  const checks = [
    {
      w: "daily_spend_limit",
      used: projected(o.spendToday, o.reservedSpendToday, o.estCost, -(o.creditsToday ?? 0)),
      cap: o.dailySpendLimitNanos,
      label: "daily spend limit",
      money: true,
    },
    {
      w: "monthly_spend_limit",
      used: projected(
        o.spendThisMonth,
        o.reservedSpendMonth,
        o.estCost,
        -(o.creditsThisMonth ?? 0),
      ),
      cap: o.monthlySpendLimitNanos,
      label: "monthly spend limit",
      money: true,
    },
    {
      w: "lifetime_spend_limit",
      used: projected(o.totalSpend, o.reservedSpendTotal, o.estCost, -(o.creditsTotal ?? 0)),
      cap: o.lifetimeSpendLimitNanos,
      label: "lifetime spend limit",
      money: true,
    },
    {
      w: "daily_token_limit",
      used: projected(o.tokensToday, o.reservedTokensToday, o.estTokens),
      cap: o.dailyTokenLimit,
      label: "daily token limit",
      money: false,
    },
    {
      w: "monthly_token_limit",
      used: projected(o.tokensThisMonth, o.reservedTokensMonth, o.estTokens),
      cap: o.monthlyTokenLimit,
      label: "monthly token limit",
      money: false,
    },
    {
      w: "lifetime_token_limit",
      used: projected(o.totalTokens, o.reservedTokensTotal, o.estTokens),
      cap: o.lifetimeTokenLimit,
      label: "lifetime token limit",
      money: false,
    },
  ];

  const violations: { code: string; reason: string; }[] = [];
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
        `${o.label} "${o.name}" at ${
          Math.round((Number(c.used) / c.cap) * 100)
        }% of ${c.label} (${capStr})`,
      );
    }
  }

  if (violations.length === 0) return { warnings: [], notices };
  if (o.enforcement === "soft") {
    return { warnings: violations.map((v) => v.reason), notices };
  }
  return { hard: violations[0], warnings: [], notices };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// A cap plus any one-time bump. Returns undefined when there's no base cap
// (a bump alone never creates a cap).
const withBump = (base: number | undefined, bump: number | undefined) =>
  base === undefined ? undefined : checkedAccounting({ cap: base + (bump ?? 0) }).cap;

const hasAnyCap = (e: {
  dailySpendLimitNanos?: number;
  monthlySpendLimitNanos?: number;
  lifetimeSpendLimitNanos?: number;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  lifetimeTokenLimit?: number;
}) =>
  e.dailySpendLimitNanos !== undefined
  || e.monthlySpendLimitNanos !== undefined
  || e.lifetimeSpendLimitNanos !== undefined
  || e.dailyTokenLimit !== undefined
  || e.monthlyTokenLimit !== undefined
  || e.lifetimeTokenLimit !== undefined;

// A bucket needs a reservation row-write if it has any spend/token cap OR a
// concurrency cap (which reads pendingCount, incremented at reserve time).
const needsReserve = (e: Parameters<typeof hasAnyCap>[0] & { maxConcurrent?: number; }) =>
  hasAnyCap(e) || e.maxConcurrent !== undefined;

async function getBucketDoc(ctx: MutationCtx | QueryCtx, dimension: string, value: string) {
  return await ctx.db
    .query("buckets")
    .withIndex("dim_value", (q) => q.eq("dimension", dimension).eq("value", value))
    .unique();
}

async function deletionOf(ctx: MutationCtx | QueryCtx, dimension: string, value: string) {
  return ctx.db.query("deletions").withIndex(
    "dim_value",
    q => q.eq("dimension", dimension).eq("value", value),
  ).unique();
}
async function getOrCreateBucket(
  ctx: MutationCtx,
  dimension: string,
  value: string,
  allowRecreate = false,
) {
  const deletion = await deletionOf(ctx, dimension, value);
  if (
    deletion?.deleting || (deletion && !allowRecreate && !await getBucketDoc(ctx, dimension, value))
  ) throw new Error("Bucket deleted; recreate explicitly with setLimits");
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
  const existing = await ctx.db.query("bucketPolicies").withIndex(
    "dim_value",
    q => q.eq("dimension", b.dimension).eq("value", b.value),
  ).unique();
  const policy = {
    bucketId: b._id,
    dimension: b.dimension,
    value: b.value,
    reconciling: existing?.reconciling,
    requestsPerMinute: b.requestsPerMinute,
    maxConcurrent: b.maxConcurrent,
    dailySpendLimitNanos: b.dailySpendLimitNanos,
    monthlySpendLimitNanos: b.monthlySpendLimitNanos,
    lifetimeSpendLimitNanos: b.lifetimeSpendLimitNanos,
    dailyTokenLimit: b.dailyTokenLimit,
    monthlyTokenLimit: b.monthlyTokenLimit,
    lifetimeTokenLimit: b.lifetimeTokenLimit,
    blocked: b.blocked,
    warnAtPct: b.warnAtPct,
    enforcement: b.enforcement,
  };
  if (existing) await ctx.db.replace(existing._id, policy);
  else await ctx.db.insert("bucketPolicies", policy);
}

async function admissionBucket(
  ctx: MutationCtx,
  dimension: string,
  value: string,
): Promise<Doc<"buckets">> {
  const policy = await ctx.db.query("bucketPolicies").withIndex(
    "dim_value",
    q => q.eq("dimension", dimension).eq("value", value),
  ).unique();
  if (!policy) {
    const bucket = await getOrCreateBucket(ctx, dimension, value);
    await syncPolicy(ctx, bucket);
    return bucket;
  }
  // Only capped buckets need an atomic read of their accounting state.
  if (needsReserve(policy)) return (await ctx.db.get(policy.bucketId))!;
  return {
    ...policy,
    _id: policy.bucketId,
    totalSpendNanos: 0,
    totalRequests: 0,
    totalTokens: 0,
    dayStamp: "",
    spendTodayNanos: 0,
  };
}

// Does this bucket have a cap (so its row must be updated live at settle for
// enforcement)? Reads the cold policy table, not the hot counter row. Uncapped
// buckets are folded into their row lazily by the reconciler's rollupPhase.
async function bucketIsCapped(
  ctx: MutationCtx,
  dimension: string,
  value: string,
): Promise<boolean> {
  const policy = await ctx.db
    .query("bucketPolicies")
    .withIndex("dim_value", (q) => q.eq("dimension", dimension).eq("value", value))
    .unique();
  return policy ? needsReserve(policy) : false;
}

async function getSettings(ctx: MutationCtx | QueryCtx) {
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
    reused: v.optional(v.boolean()),
    warnings: v.array(v.string()), // soft caps exceeded (allowed with a warning)
    notices: v.array(v.string()), // approaching a cap (warnAtPct threshold)
  }),
  v.object({
    allowed: v.literal(false),
    code: v.string(),
    reason: v.string(),
  }),
);

export const startRequest = mutation({
  args: {
    idempotencyKey: v.optional(v.string()),
    userId: v.string(),
    // Host-derived old subject key: prevent an identity upgrade bypassing its budget.
    legacyUserId: v.optional(v.string()),
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
    estimatedTokens: v.optional(v.number()),
    // Hold the reservation this long (ms) before the reconciler may reap it —
    // for long async jobs (video) that settle minutes later. Extends the 30-min
    // default floor.
    reserveTtlMs: v.optional(v.number()),
    rerunOf: v.optional(v.id("requests")),
  },
  returns: vStartResult,
  handler: async (ctx, args): Promise<Infer<typeof vStartResult>> => {
    assertKey(args.userId, "userId", 1024);
    if (args.legacyUserId !== undefined) {
      assertKey(args.legacyUserId, "legacyUserId", 1024);
      if (
        args.legacyUserId !== args.userId && (
          await getBucketDoc(ctx, "user", args.legacyUserId)
          || await deletionOf(ctx, "user", args.legacyUserId)
        )
      ) {
        return {
          allowed: false as const,
          code: "identity_migration_required",
          reason:
            "A legacy subject-keyed budget exists. Migrate its identity before using issuer-scoped keys, or explicitly retain subject keys for a trusted single issuer.",
        };
      }
    }
    assertKey(args.model, "model");
    if (args.actionName !== undefined) assertKey(args.actionName, "actionName");
    assertAmount(args.reserveTtlMs, "reserveTtlMs");
    if ((args.reserveTtlMs ?? 0) > 30 * 24 * 60 * 60 * 1000) {
      throw new Error("reserveTtlMs cannot exceed 30 days");
    }
    // Infinity/NaN here is catastrophic: it's reserved onto the bucket, and a
    // later release computes `Infinity - Infinity = NaN`, leaving the reserved
    // fields NaN forever — after which every `used > cap` check is `NaN > cap`
    // (false) and the bucket admits unlimited spend. Reject it up front.
    assertAmount(args.estimatedCostNanos, "estimatedCostNanos");
    assertAmount(args.estimatedTokens, "estimatedTokens");
    const extraTags = sanitizeExtraTags(args.tags);
    let fingerprint: string | undefined;
    if (args.idempotencyKey !== undefined) {
      if (!args.idempotencyKey || args.idempotencyKey.length > 128) {
        throw new Error("idempotencyKey must have 1–128 characters");
      }
      const bytes = new TextEncoder().encode(JSON.stringify({
        userId: args.userId,
        action: args.actionName ?? null,
        model: args.model,
        messages: args.messages,
        tags: extraTags,
        estimatedCostNanos: args.estimatedCostNanos ?? null,
        estimatedTokens: args.estimatedTokens ?? null,
        reserveTtlMs: args.reserveTtlMs ?? null,
        rerunOf: args.rerunOf ?? null,
      }));
      fingerprint = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        b => b.toString(16).padStart(2, "0"),
      ).join("");
      const key = await ctx.db.query("admissionKeys").withIndex(
        "user_key",
        q => q.eq("userId", args.userId).eq("key", args.idempotencyKey!),
      ).unique();
      if (key) {
        if (key.fingerprint !== fingerprint) {
          throw new Error("idempotencyKey was already used with different arguments");
        }
        const req = await ctx.db.get(key.requestId);
        if (!req) {
          return {
            allowed: false as const,
            code: "idempotency_expired",
            reason:
              "Original request was retained then removed; use a new key only for a new provider job",
          };
        }
        return {
          allowed: true as const,
          requestId: key.requestId,
          reused: true,
          warnings: [],
          notices: [],
        };
      }
    }
    // Set from settings below; when false we persist metadata but no prompt
    // content (a deployment that opts out of storing prompts entirely).
    let storeContent = true;
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
          messages: storeContent ? capMessages(args.messages) : [],
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
    if (args.estimatedTokens !== undefined) est.tokens = args.estimatedTokens;
    assertAmount(est.cost, "estimated cost");
    assertAmount(est.tokens, "estimated tokens");
    const warnings: string[] = [];
    const notices: string[] = [];

    // Model allow/deny policy (component-wide).
    const settings = await getSettings(ctx);
    storeContent = settings?.storeContent !== false;
    const defaultWarnAtPct = settings?.defaultWarnAtPct;
    // A 0/0 reservation would satisfy "defined" while reserving nothing, defeating
    // the atomic hard-cap bound this policy promises — require POSITIVE bounds.
    if (
      settings?.requireExplicitReservations
      && !((args.estimatedCostNanos ?? 0) > 0 && (args.estimatedTokens ?? 0) > 0)
    ) {
      return reject(
        "explicit_reservation_required",
        "Provide positive explicit spend and token reservation bounds",
      );
    }
    if (settings) {
      const mode = settings.modelMode ?? "open";
      const list = settings.models ?? [];
      if (mode === "allowlist" && !list.includes(args.model)) {
        return reject(
          "model_not_allowed",
          `Model "${args.model}" is not on the allowlist`,
        );
      }
      if (mode === "denylist" && list.includes(args.model)) {
        return reject("model_denied", `Model "${args.model}" is denied`);
      }
      // Optionally refuse models with no known/override price rather than
      // charging the conservative fallback (which under-counts premium models).
      if (settings.allowUnpricedModels === false && !priceInfo.known) {
        return reject(
          "model_unpriced",
          `Model "${args.model}" has no configured price; set one with setPrice or allow unpriced models`,
        );
      }
    }

    // Fetch/create every bucket this request is attributed to (user, action,
    // and any extra tags). Each may carry its own budget.
    const bucketTags = requestBuckets(args.userId, args.actionName, extraTags);
    const buckets: Doc<"buckets">[] = [];
    for (const t of bucketTags) {
      const deletion = await deletionOf(ctx, t.dimension, t.value);
      if (deletion?.deleting || (deletion && !await getBucketDoc(ctx, t.dimension, t.value))) {
        return reject("bucket_deleted", "Budget bucket has been deleted", false);
      }
      const policy = await ctx.db.query("bucketPolicies").withIndex(
        "dim_value",
        q => q.eq("dimension", t.dimension).eq("value", t.value),
      ).unique();
      if (policy?.reconciling) {
        return reject(
          "bucket_reconciling",
          "Budget policy is being reconciled; retry shortly",
          false,
        );
      }
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
          b.dimension !== USER_DIM,
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
          false,
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
        ctx,
        "requests",
        requestRateOptions(b),
      )).ok;
      if (!ok) {
        const code = b.dimension === USER_DIM ? "rate_limit" : `${b.dimension}_rate_limit`;
        return reject(
          code,
          `Rate limit exceeded for ${b.dimension} "${b.value}" (${limit}/min)`,
          false,
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
        creditsToday: sameDay ? b.creditsTodayNanos ?? 0 : 0,
        creditsThisMonth: sameMonth ? b.creditsThisMonthNanos ?? 0 : 0,
        creditsTotal: b.creditsNanos ?? 0,
        tokensToday: sameDay ? b.tokensToday ?? 0 : 0,
        reservedTokensToday: sameDay ? b.reservedTodayTokens ?? 0 : 0,
        tokensThisMonth: sameMonth ? b.tokensThisMonth ?? 0 : 0,
        reservedTokensMonth: sameMonth ? b.reservedMonthTokens ?? 0 : 0,
        totalTokens: b.totalTokens,
        reservedTokensTotal: b.reservedTotalTokens ?? 0,
        dailySpendLimitNanos: withBump(
          b.dailySpendLimitNanos,
          b.bumpDayStamp === today ? b.dailyBumpNanos : 0,
        ),
        monthlySpendLimitNanos: withBump(
          b.monthlySpendLimitNanos,
          b.bumpMonthStamp === month ? b.monthlyBumpNanos : 0,
        ),
        lifetimeSpendLimitNanos: withBump(
          b.lifetimeSpendLimitNanos,
          b.lifetimeBumpNanos,
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
    // H4: don't read the sharded counter here — that per-admission read
    // contended with every fold that writes it. The reconciler compares the
    // total to the cap out-of-band and records trip flags on `settings`;
    // admission just reads those (already-loaded) flags. The killswitch lag is
    // bounded by the reconcile interval, which is the point of "approximate".
    if (
      settings
      && (settings.globalTrippedDaily || settings.globalTrippedLifetime)
    ) {
      const enforcement = settings.globalEnforcement ?? "approximate";
      if (enforcement === "soft") {
        warnings.push(`Global spend limit reached for the deployment (allowed — soft)`);
      } else {
        return reject(
          "global_spend_limit",
          "Global spend limit reached for the deployment",
        );
      }
    } else if (settings?.globalNearLimit) {
      notices.push("Deployment approaching its global spend limit");
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
      await ctx.db.patch(
        b._id,
        checkedAccounting({
          ...windowResets(b, today, month),
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
        }),
      );
    }
    const requestId = await ctx.db.insert("requests", {
      userId: args.userId,
      actionName: args.actionName,
      ...(extraTags.length ? { tags: extraTags } : {}),
      model: args.model,
      messages: storeContent ? capMessages(args.messages) : [],
      rerunOf: args.rerunOf,
      ...(args.reserveTtlMs !== undefined ? { reserveTtlMs: args.reserveTtlMs } : {}),
      status: "pending",
      expiresAt: Date.now() + Math.max(STALE_PENDING_MS, args.reserveTtlMs ?? 0),
      heldBucketIds: buckets.filter(needsReserve).map(b => b._id),
      attributedBuckets: buckets.map(b => ({
        dimension: b.dimension,
        value: b.value,
        bucketId: b._id,
      })),
      priceSnapshot: {
        input: priceInfo.input,
        output: priceInfo.output,
        cached: cachedRate(priceInfo),
        cacheWrite: priceInfo.cacheWrite ?? Math.round(priceInfo.input * 1.25),
        cacheWrite1h: priceInfo.cacheWrite1h ?? priceInfo.input * 2,
      },
      serverToolPriceSnapshot: {
        ...DEFAULT_SERVER_TOOL_PRICES,
        ...(settings?.serverToolPrices ?? {}),
      },
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
    if (args.idempotencyKey !== undefined) {
      await ctx.db.insert("admissionKeys", {
        userId: args.userId,
        key: args.idempotencyKey,
        fingerprint: fingerprint!,
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
    cachedWriteTokens: v.optional(v.number()),
    cachedWrite1hTokens: v.optional(v.number()),
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
    if (!request) {
      const event = await ctx.db.query("billingEvents").withIndex(
        "requestId",
        q => q.eq("requestId", args.requestId),
      ).unique();
      return { costNanos: event?.costNanos ?? 0 };
    }

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
    const cachedWriteTokens = Math.min(
      promptTokens - cachedTokens,
      safeCount(args.cachedWriteTokens),
    );
    const cachedWrite1hTokens = Math.min(cachedWriteTokens, safeCount(args.cachedWrite1hTokens));
    assertAmount(promptTokens + completionTokens, "total tokens");
    if (args.serverToolUses) {
      if (Object.keys(args.serverToolUses).length > MAX_SERVER_TOOLS) {
        throw new Error("Too many server-tool counters");
      }
      for (const [tool, count] of Object.entries(args.serverToolUses)) {
        assertKey(tool, "tool", 64);
        assertAmount(count, `serverToolUses.${tool}`);
      }
    }
    assertAmount(args.latencyMs, "latencyMs");
    // Prefer an authoritative gateway cost when supplied (it already includes
    // tool fees); otherwise price from tokens — discounting the cached
    // (prompt-cache-read) slice — plus any server-tool per-call fees. Require it
    // finite: +Infinity passes a bare `>= 0` and would corrupt the totals.
    const settings = await getSettings(ctx);
    const storeContent = settings?.storeContent !== false;
    let costNanos: number;
    let costSource: "authoritative" | "token_estimate" | "reservation_estimate";
    if (args.costNanos !== undefined && Number.isFinite(args.costNanos) && args.costNanos >= 0) {
      costSource = "authoritative";
      costNanos = Math.round(args.costNanos);
      assertAmount(costNanos, "costNanos");
    } else {
      const priced = settleCost(
        promptTokens,
        cachedTokens,
        completionTokens,
        request.priceSnapshot ?? await getPrice(ctx, request.model),
        cachedWriteTokens,
        cachedWrite1hTokens,
      )
        + serverToolCost(
          args.serverToolUses,
          request.serverToolPriceSnapshot ?? settings?.serverToolPrices,
        );
      // Fail closed: if the settle carried NO usable cost signal — no tokens and
      // no priced server-tool fee (an unpriced tool like `video_seconds`, or a
      // bare settle()) — fall back to the reserved estimate rather than recording
      // $0. Known-cost calls (image/video/audio) set estimatedCostNanos at
      // reserve time precisely so this floor is their real cost. A caller that
      // truly wants $0 passes an explicit authoritative costNanos: 0 above.
      const noSignal = promptTokens === 0 && completionTokens === 0 && priced === 0;
      if (noSignal && args.error) {
        // A FAILED call with no usage signal is not charged — the provider
        // doesn't bill for a failure, and charging the reserved estimate here
        // would bill every error. (If the provider DID bill before the callback
        // threw, pass an authoritative `costNanos` or usage so it's recorded.)
        costSource = "token_estimate";
        costNanos = 0;
      } else {
        costSource = noSignal ? "reservation_estimate" : "token_estimate";
        costNanos = noSignal ? (request.estimatedNanos ?? 0) : priced;
      }
    }

    assertAmount(costNanos, "costNanos");

    // Durable write to the request's OWN row only — uncontended, so it always
    // lands. `settled: false` hands it to the fold step; the row is never left
    // orphaned in "pending" even if the totals update below fails and retries.
    await ctx.db.patch(args.requestId, {
      status: args.error ? "error" : "success",
      reservationExpired: false,
      expiresAt: undefined,
      finishedAt: Date.now(),
      messages: storeContent && !request.privacyErased ? request.messages : [],
      responseText: storeContent && !request.privacyErased
        ? capResponse(args.responseText)
        : undefined,
      error: args.error
        ? (storeContent && settings?.storeRawErrors === true && !request.privacyErased
          ? capResponse(args.error)
          : "provider_error")
        : undefined,
      promptTokens,
      completionTokens,
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
      ...(cachedWriteTokens > 0 ? { cachedWriteTokens } : {}),
      ...(cachedWrite1hTokens > 0 ? { cachedWrite1hTokens } : {}),
      ...(args.serverToolUses
        ? { serverToolUses: boundServerTools(args.serverToolUses) }
        : {}),
      costNanos,
      costSource,
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
    await ctx.db.patch(
      b._id,
      checkedAccounting({
        reservedTodayNanos: Math.max(
          0,
          fin(b.reservedTodayNanos) - (b.dayStamp === day ? cost : 0),
        ),
        reservedMonthNanos: Math.max(
          0,
          fin(b.reservedMonthNanos) - (b.monthStamp === month ? cost : 0),
        ),
        reservedTotalNanos: Math.max(0, fin(b.reservedTotalNanos) - cost),
        reservedTodayTokens: Math.max(
          0,
          fin(b.reservedTodayTokens) - (b.dayStamp === day ? tokens : 0),
        ),
        reservedMonthTokens: Math.max(
          0,
          fin(b.reservedMonthTokens) - (b.monthStamp === month ? tokens : 0),
        ),
        reservedTotalTokens: Math.max(0, fin(b.reservedTotalTokens) - tokens),
        pendingCount: Math.max(0, fin(b.pendingCount) - 1),
      }),
    );
  }
  await ctx.db.patch(req._id, checkedAccounting({ reservationReleased: true }));
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
    if (req.privacyErased && t.dimension === USER_DIM) continue;
    const bNow = await getBucketDoc(ctx, t.dimension, t.value);
    const attributed = req.attributedBuckets?.find(x =>
      x.dimension === t.dimension && x.value === t.value
    );
    const deletion = await deletionOf(ctx, t.dimension, t.value);
    if (
      attributed
        ? attributed.bucketId !== bNow?._id
        : deletion && req._creationTime <= deletion._creationTime
    ) continue;
    // Capped buckets need their row updated LIVE so the next admission sees the
    // spend (enforcement can't wait for the async rollup). They're per-user /
    // low-concurrency, so the row isn't a hot contention point. Uncapped buckets
    // (the shared action/tag rows) get NO write here — only an append-only delta
    // the reconciler drains — so a hot shared dimension never serializes settles.
    const capped = await bucketIsCapped(ctx, t.dimension, t.value);
    if (capped) {
      const b = await getBucketDoc(ctx, t.dimension, t.value);
      if (b) {
        const targetDay = b.dayStamp > day ? b.dayStamp : day;
        const targetMonth = (b.monthStamp ?? "") > month ? b.monthStamp! : month;
        await ctx.db.patch(
          b._id,
          checkedAccounting({
            totalSpendNanos: b.totalSpendNanos + actual,
            totalRequests: b.totalRequests + 1,
            totalTokens: b.totalTokens + tokens,
            ...windowResets(b, targetDay, targetMonth),
            dayStamp: targetDay,
            monthStamp: targetMonth,
            spendTodayNanos: (b.dayStamp === targetDay ? b.spendTodayNanos : 0)
              + (day === targetDay ? actual : 0),
            tokensToday: (b.dayStamp === targetDay ? b.tokensToday ?? 0 : 0)
              + (day === targetDay ? tokens : 0),
            spendThisMonthNanos: (b.monthStamp === targetMonth ? b.spendThisMonthNanos ?? 0 : 0)
              + (month === targetMonth ? actual : 0),
            tokensThisMonth: (b.monthStamp === targetMonth ? b.tokensThisMonth ?? 0 : 0)
              + (month === targetMonth ? tokens : 0),
            ...(b.dayStamp !== targetDay ? { reservedTodayNanos: 0, reservedTodayTokens: 0 } : {}),
            ...(b.monthStamp !== targetMonth
              ? { reservedMonthNanos: 0, reservedMonthTokens: 0 }
              : {}),
            // settle hot path: saturate on overflow, never throw (see checkedAccounting)
          }, { saturate: true }),
        );
      }
    }
    // Append-only delta: rollupPhase folds it into `usage` (history, all buckets)
    // and, when uncapped, into the bucket-row totals.
    await ctx.db.insert("usageDeltas", {
      dimension: t.dimension,
      value: t.value,
      day,
      month,
      spendNanos: actual,
      tokens,
      requests: 1,
      drainToRow: !capped,
      ...(bNow ? { bucketId: bNow._id } : {}),
    });
  }
  await ctx.db.insert("billingEvents", {
    requestId: req._id,
    costNanos: actual,
    costSource: req.costSource,
    tokens,
    finishedAt: req.finishedAt ?? Date.now(),
    bucketIds: req.attributedBuckets?.map(t => t.bucketId) ?? [],
  });
  // Reporting is independent of whether enforcement is configured.
  if (actual > 0) {
    await globalSpend.add(ctx, GLOBAL_TOTAL, actual);
    await globalSpend.add(ctx, globalDayKey(day), actual);
  }
  await ctx.db.patch(req._id, checkedAccounting({ settled: true }));
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
// Cron entry: kick off each reconciliation phase as its OWN transaction so a
// failure in one (e.g. an oversized retention scan) can't stall the others, and
// so the hot fold path doesn't share a transaction with retention. Each phase
// self-reschedules while it has a full batch of backlog.
export const reconcile = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const transitions = await ctx.db.query("bucketPolicies").withIndex(
      "reconciling",
      q => q.eq("reconciling", true),
    ).take(RECONCILE_BATCH);
    for (const p of transitions) {
      await ctx.scheduler.runAfter(0, internal.lib.reconcileBucket, {
        bucketId: p.bucketId,
        cursor: null,
      });
    }
    const deletions = await ctx.db.query("deletions").withIndex(
      "deleting",
      q => q.eq("deleting", true),
    ).take(RECONCILE_BATCH);
    for (const d of deletions) {
      await ctx.scheduler.runAfter(0, internal.lib.deleteBucketBatch, {
        dimension: d.dimension,
        value: d.value,
      });
    }
    await ctx.scheduler.runAfter(0, internal.lib.foldPhase, {});
    await ctx.scheduler.runAfter(0, internal.lib.rollupPhase, {});
    await ctx.scheduler.runAfter(0, internal.lib.expirePhase, {});
    await ctx.scheduler.runAfter(0, internal.lib.retentionPhase, {});
    await ctx.scheduler.runAfter(0, internal.lib.globalPhase, {});
    return null;
  },
});

async function drainDelta(ctx: MutationCtx, d: Doc<"usageDeltas">) {
  const current = await getBucketDoc(ctx, d.dimension, d.value);
  const deletion = await deletionOf(ctx, d.dimension, d.value);
  if (
    d.bucketId
      ? current?._id !== d.bucketId
      : deletion && d._creationTime <= deletion._creationTime
  ) {
    await ctx.db.delete(d._id);
    return;
  }
  await addUsage(ctx, d.dimension, d.value, "day", d.day, d.spendNanos, d.tokens, d.requests);
  await addUsage(ctx, d.dimension, d.value, "month", d.month, d.spendNanos, d.tokens, d.requests);
  if (d.drainToRow) {
    const b = await getOrCreateBucket(ctx, d.dimension, d.value);
    const targetDay = b.dayStamp > d.day ? b.dayStamp : d.day;
    const targetMonth = (b.monthStamp ?? "") > d.month ? b.monthStamp! : d.month;
    await ctx.db.patch(
      b._id,
      checkedAccounting({
        totalSpendNanos: b.totalSpendNanos + d.spendNanos,
        totalRequests: b.totalRequests + d.requests,
        totalTokens: b.totalTokens + d.tokens,
        ...windowResets(b, targetDay, targetMonth),
        dayStamp: targetDay,
        monthStamp: targetMonth,
        spendTodayNanos: (b.dayStamp === targetDay ? b.spendTodayNanos : 0)
          + (d.day === targetDay ? d.spendNanos : 0),
        tokensToday: (b.dayStamp === targetDay ? b.tokensToday ?? 0 : 0)
          + (d.day === targetDay ? d.tokens : 0),
        spendThisMonthNanos: (b.monthStamp === targetMonth ? b.spendThisMonthNanos ?? 0 : 0)
          + (d.month === targetMonth ? d.spendNanos : 0),
        tokensThisMonth: (b.monthStamp === targetMonth ? b.tokensThisMonth ?? 0 : 0)
          + (d.month === targetMonth ? d.tokens : 0),
        // reconcile hot path: saturate on overflow, never throw (see checkedAccounting)
      }, { saturate: true }),
    );
  }
  await ctx.db.delete(d._id);
}

// H6: drain append-only settlement deltas into the durable `usage` history (all
// buckets) and the uncapped bucket-row totals — as a single writer, so the hot
// settle path never contends on a shared dimension's row. Self-reschedules while
// backlogged.
export const rollupPhase = internalMutation({
  args: {},
  returns: v.object({ drained: v.number() }),
  handler: async (ctx) => {
    const deltas = await ctx.db.query("usageDeltas").take(RECONCILE_BATCH);
    for (const d of deltas) await drainDelta(ctx, d);
    if (deltas.length === RECONCILE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.lib.rollupPhase, {});
    }
    return { drained: deltas.length };
  },
});

// H4: compute the deployment-wide global-cap trip flags out-of-band so admission
// never reads the sharded counter on its hot path. One cheap counter read here
// per interval; admission then consults the flags on `settings`.
export const globalPhase = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const s = await getSettings(ctx);
    const today = dayStamp(), month = monthStamp();
    if (!s) {
      await ctx.db.insert("settings", {
        key: "singleton",
        reportingDay: today,
        reportingMonth: month,
        globalCheckedAt: Date.now(),
      });
      return null;
    }
    if (s.reportingDay !== today || s.reportingMonth !== month) {
      await ctx.db.patch(s._id, { reportingDay: today, reportingMonth: month });
    }
    const hasCap = s.globalDailySpendLimitNanos !== undefined
      || s.globalLifetimeSpendLimitNanos !== undefined;
    if (!hasCap) {
      // Clear stale flags when no global cap is configured.
      if (s.globalTrippedDaily || s.globalTrippedLifetime || s.globalNearLimit) {
        await ctx.db.patch(s._id, {
          globalTrippedDaily: false,
          globalTrippedLifetime: false,
          globalNearLimit: false,
        });
      }
      return null;
    }
    const dailyCap = withBump(
      s.globalDailySpendLimitNanos,
      s.globalBumpDayStamp === today ? s.globalDailyBumpNanos : 0,
    );
    const lifetimeCap = withBump(
      s.globalLifetimeSpendLimitNanos,
      s.globalLifetimeBumpNanos,
    );
    const spentToday = await globalSpend.count(ctx, globalDayKey(today));
    const spentTotal = await globalSpend.count(ctx, GLOBAL_TOTAL);
    const pct = s.defaultWarnAtPct;
    const near = (spent: number, cap?: number) =>
      cap !== undefined && pct !== undefined && pct > 0 && pct < 1 && spent >= pct * cap;
    await ctx.db.patch(s._id, {
      globalCheckedAt: Date.now(),
      globalTrippedDaily: dailyCap !== undefined && spentToday >= dailyCap,
      globalTrippedLifetime: lifetimeCap !== undefined && spentTotal >= lifetimeCap,
      globalNearLimit: near(spentToday, dailyCap) || near(spentTotal, lifetimeCap),
    });
    return null;
  },
});

// Fold finished-but-unfolded requests whose scheduled fold lost the OCC race.
export const foldPhase = internalMutation({
  args: {},
  returns: v.object({ folded: v.number() }),
  handler: async (ctx) => {
    const toFold = await ctx.db
      .query("requests")
      .withIndex("settled", (q) => q.eq("settled", false))
      .take(RECONCILE_BATCH);
    for (const req of toFold) await foldOne(ctx, req);
    if (toFold.length === RECONCILE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.lib.foldPhase, {});
    }
    return { folded: toFold.length };
  },
});

// Release reservations for requests that never settled (their action crashed),
// and lazily backfill deadlines on legacy pending rows.
export const expirePhase = internalMutation({
  args: {},
  returns: v.object({ expired: v.number() }),
  handler: async (ctx) => {
    const legacyExpired = await ctx.db.query("requests").withIndex(
      "retention_expiredAt",
      q => q.eq("reservationExpired", true).eq("settled", true).eq("expiredAt", undefined),
    ).take(RECONCILE_BATCH);
    for (const req of legacyExpired) await ctx.db.patch(req._id, { expiredAt: Date.now() });
    // Lazily migrate old pending rows in bounded batches. Once indexed, long
    // TTL jobs cannot hide expired jobs behind them in creation-time order.
    const legacy = await ctx.db.query("requests").withIndex(
      "status_expires",
      q => q.eq("status", "pending").eq("expiresAt", undefined),
    ).take(RECONCILE_BATCH);
    for (const req of legacy) {
      await ctx.db.patch(
        req._id,
        checkedAccounting({
          expiresAt: req._creationTime + Math.max(STALE_PENDING_MS, req.reserveTtlMs ?? 0),
        }),
      );
    }
    const candidates = await ctx.db.query("requests").withIndex(
      "status_expires",
      q => q.eq("status", "pending").gt("expiresAt", 0).lte("expiresAt", Date.now()),
    ).take(RECONCILE_BATCH);
    for (const req of candidates) {
      await releaseReservation(ctx, req);
      await ctx.db.patch(
        req._id,
        checkedAccounting({
          status: "error",
          error: "Reservation expired; awaiting final usage",
          reservationExpired: true,
          expiredAt: Date.now(),
          expiresAt: undefined,
          settled: true,
        }),
      );
    }
    if (
      legacyExpired.length === RECONCILE_BATCH || legacy.length === RECONCILE_BATCH
      || candidates.length === RECONCILE_BATCH
    ) {
      await ctx.scheduler.runAfter(0, internal.lib.expirePhase, {});
    }
    return { expired: candidates.length };
  },
});

// Delete terminal, fully-accounted request rows past the retention window; purge
// content from expired tombstones; and finally delete tombstones past the
// late-settle horizon so they can't accumulate forever.
export const retentionPhase = internalMutation({
  args: {},
  returns: v.object({ purged: v.number() }),
  handler: async (ctx) => {
    const settings = await getSettings(ctx);
    const retentionMs = settings?.retentionMs ?? DEFAULT_RETENTION_MS;
    if (retentionMs <= 0) return { purged: 0 };
    const retentionCutoff = Date.now() - retentionMs;
    let purged = 0;
    let more = false;
    const sweep = async (rows: Doc<"requests">[]) => {
      for (const req of rows) {
        await deleteRequestTags(ctx, req._id);
        await ctx.db.delete(req._id);
        purged++;
      }
      if (rows.length === RECONCILE_BATCH) more = true;
    };
    // Settled, non-expired terminal rows past the window.
    for (const expiredFlag of [undefined, false] as const) {
      await sweep(
        await ctx.db.query("requests").withIndex(
          "retention",
          q =>
            q.eq("reservationExpired", expiredFlag).eq("settled", true)
              .lt("_creationTime", retentionCutoff),
        ).take(RECONCILE_BATCH),
      );
    }
    // Blocked attempts past the window.
    await sweep(
      await ctx.db.query("requests").withIndex(
        "status",
        q => q.eq("status", "blocked").lt("_creationTime", retentionCutoff),
      ).take(RECONCILE_BATCH),
    );
    // Expired billing tombstones past the late-settle horizon (content already
    // gone). Without this they'd live forever (one per crashed request).
    const tombstoneCutoff = Date.now() - Math.max(retentionMs, LATE_SETTLE_HORIZON_MS);
    await sweep(
      await ctx.db.query("requests").withIndex(
        "retention_expiredAt",
        q =>
          q.eq("reservationExpired", true).eq("settled", true)
            .gt("expiredAt", 0).lt("expiredAt", tombstoneCutoff),
      ).take(RECONCILE_BATCH),
    );
    // Strip PII from expired tombstones still inside the horizon.
    const expiredContent = await ctx.db.query("requests").withIndex(
      "expired_content",
      q =>
        q.eq("reservationExpired", true).eq("contentPurged", undefined)
          .lt("_creationTime", retentionCutoff),
    ).take(RECONCILE_BATCH);
    for (const req of expiredContent) {
      await ctx.db.patch(
        req._id,
        checkedAccounting({
          messages: [],
          responseText: undefined,
          error: "reservation_expired",
          contentPurged: true,
        }),
      );
    }
    if (expiredContent.length === RECONCILE_BATCH) more = true;
    if (more) await ctx.scheduler.runAfter(0, internal.lib.retentionPhase, {});
    return { purged };
  },
});

async function auditAdmin(
  ctx: MutationCtx,
  operation: string,
  args: { actorId?: string; dimension?: string; value?: string; } & Record<string, unknown>,
) {
  const { actorId, ...details } = args;
  await ctx.db.insert("adminEvents", {
    operation,
    actorId: actorId ?? "host",
    dimension: args.dimension,
    value: args.value,
    // Bound the row: admin args (e.g. a huge `reason` or `models` list) must not
    // push the audit doc toward the 1 MiB limit (which would fail the whole
    // admin mutation) or blow the 8 MiB read limit in paginateAdminEvents.
    detailsJson: truncate(JSON.stringify(details), MAX_AUDIT_DETAILS),
  });
}
export const setRetention = mutation({
  args: { actorId: v.optional(v.string()), retentionMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "setRetention", args);
    const { retentionMs } = args;
    assertAmount(retentionMs, "retentionMs");
    const existing = await getSettings(ctx);
    if (existing) await ctx.db.patch(existing._id, checkedAccounting({ retentionMs }));
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
    while (cursor?.rerunOf && ancestors.length < 25) {
      const parent = await ctx.db.get(cursor.rerunOf);
      if (!parent) break;
      ancestors.unshift(parent);
      cursor = parent;
    }
    const reruns = await ctx.db
      .query("requests")
      .withIndex("rerunOf", (q) => q.eq("rerunOf", requestId))
      .take(25);
    return { ancestors, reruns, truncated: ancestors.length === 25 || reruns.length === 25 };
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
    // Clamp the page size so a caller can't force a scan past the transaction's
    // read limits, and strip prompt/response content from the LOG view — it's a
    // metadata list (the dashboard renders no content), and returning up to
    // `limit` full rows risks both the read-bytes and return-size limits. Full
    // content is available per-row via getRequest.
    const limit = pageSize(args.limit, 50, MAX_LIST);
    const strip = (r: Doc<"requests">) => ({
      ...r,
      messages: [],
      responseText: undefined,
    });
    const dim = args.dimension;
    const val = args.value ?? args.userId;
    let rows: Doc<"requests">[];
    if (dim === undefined && args.userId !== undefined) {
      const userId = args.userId;
      rows = await ctx.db
        .query("requests")
        .withIndex("userId", (q) => q.eq("userId", userId))
        .order("desc")
        .take(limit);
    } else if (dim !== undefined && val !== undefined && dim === USER_DIM) {
      rows = await ctx.db
        .query("requests")
        .withIndex("userId", (q) => q.eq("userId", val))
        .order("desc")
        .take(limit);
    } else if (dim !== undefined && val !== undefined && dim === ACTION_DIM) {
      rows = await ctx.db
        .query("requests")
        .withIndex("actionName", (q) => q.eq("actionName", val))
        .order("desc")
        .take(limit);
    } else if (dim !== undefined && val !== undefined) {
      // Custom tag dimension: walk the reverse index, then fetch each request.
      const tagRows = await ctx.db
        .query("requestTags")
        .withIndex("dim_value", (q) => q.eq("dimension", dim).eq("value", val))
        .order("desc")
        .take(limit);
      const fetched = await Promise.all(tagRows.map((t) => ctx.db.get(t.requestId)));
      rows = fetched.filter((r): r is Doc<"requests"> => r !== null);
    } else {
      rows = await ctx.db.query("requests").order("desc").take(limit);
    }
    return rows.map(strip);
  },
});

const vBucket = v.object({
  ...schema.tables.buckets.validator.fields,
  _id: v.id("buckets"),
  _creationTime: v.number(),
});
export const paginateBuckets = query({
  args: { dimension: v.optional(v.string()), paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(vBucket), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (
    ctx,
    { dimension, paginationOpts },
  ): Promise<{ page: Doc<"buckets">[]; isDone: boolean; continueCursor: string; }> => {
    const options = {
      cursor: paginationOpts.cursor,
      numItems: pageSize(paginationOpts.numItems, 50),
    };
    const db = paginator(ctx.db, schema);
    const page = dimension === undefined
      ? await db.query("buckets").paginate(options)
      : await db.query("buckets").withIndex("dim_value", q => q.eq("dimension", dimension))
        .paginate(options);
    const clock = await getSettings(ctx);
    return {
      page: page.page.map(b =>
        normalizedBucket(
          b,
          clock?.reportingDay ?? dayStamp(),
          clock?.reportingMonth ?? monthStamp(),
        )
      ),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
const vHealth = v.object({
  pendingFolds: v.number(),
  pendingDeltas: v.number(),
  countsTruncated: v.boolean(),
  oldestUnfoldedAt: v.union(v.number(), v.null()),
  oldestDeltaAt: v.union(v.number(), v.null()),
  globalCheckedAt: v.union(v.number(), v.null()),
});
export const getHealth = query({
  args: {},
  returns: vHealth,
  handler: async (ctx): Promise<Infer<typeof vHealth>> => {
    // Sample a bounded window — a health probe only needs "is there a backlog",
    // not an exact count, and request rows can carry content. HEALTH_SAMPLE keeps
    // the read well under the transaction limit; >= it just flags "truncated".
    const HEALTH_SAMPLE = 51;
    const folds = await ctx.db.query("requests").withIndex("settled", q => q.eq("settled", false))
      .take(HEALTH_SAMPLE);
    const deltas = await ctx.db.query("usageDeltas").take(HEALTH_SAMPLE);
    const settings = await getSettings(ctx);
    return {
      pendingFolds: folds.length,
      pendingDeltas: deltas.length,
      countsTruncated: folds.length === HEALTH_SAMPLE || deltas.length === HEALTH_SAMPLE,
      oldestUnfoldedAt: folds[0]?.finishedAt ?? null,
      oldestDeltaAt: deltas[0]?._creationTime ?? null,
      globalCheckedAt: settings?.globalCheckedAt ?? null,
    };
  },
});

const vBillingEvent = v.object({
  ...schema.tables.billingEvents.validator.fields,
  _id: v.id("billingEvents"),
  _creationTime: v.number(),
});
export const getBillingEvent = query({
  args: { requestId: v.id("requests") },
  returns: v.union(vBillingEvent, v.null()),
  handler: (ctx, { requestId }) =>
    ctx.db.query("billingEvents").withIndex("requestId", q => q.eq("requestId", requestId))
      .unique(),
});
const vAdminEvent = v.object({
  ...schema.tables.adminEvents.validator.fields,
  _id: v.id("adminEvents"),
  _creationTime: v.number(),
});
export const paginateAdminEvents = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(vAdminEvent),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (
    ctx,
    { paginationOpts },
  ): Promise<{ page: Doc<"adminEvents">[]; isDone: boolean; continueCursor: string; }> => {
    const page = await paginator(ctx.db, schema).query("adminEvents").order("desc").paginate({
      cursor: paginationOpts.cursor,
      numItems: pageSize(paginationOpts.numItems, 50),
    });
    return { page: page.page, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

const ADMIN_LIST_CAP = 2000;
// Max rows a single listRequests page returns (content-stripped). Bounds both
// the read scan and the return-value size.
const MAX_LIST = 200;

// List budget buckets, optionally filtered to one dimension ("user", "action",
// or any custom tag dimension). Today's spend is zeroed for stale day windows.
export const listBuckets = query({
  args: { dimension: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Bounded to avoid an unbounded full-table scan on this reactive query.
    // Use paginateBuckets for larger deployments.
    const rows = args.dimension !== undefined
      ? await ctx.db
        .query("buckets")
        .withIndex("dim_value", (q) => q.eq("dimension", args.dimension!))
        .take(ADMIN_LIST_CAP)
      : await ctx.db.query("buckets").take(ADMIN_LIST_CAP);
    const clock = await getSettings(ctx);
    return rows.map(b =>
      normalizedBucket(b, clock?.reportingDay ?? dayStamp(), clock?.reportingMonth ?? monthStamp())
    );
  },
});

export const getBucket = query({
  args: { dimension: v.string(), value: v.string() },
  handler: async (ctx, args) => {
    const b = await getBucketDoc(ctx, args.dimension, args.value);
    if (!b) return null;
    const clock = await getSettings(ctx);
    return normalizedBucket(
      b,
      clock?.reportingDay ?? dayStamp(),
      clock?.reportingMonth ?? monthStamp(),
    );
  },
});

// Set a bucket's limits/controls. `user` and `action` are just dimensions here;
// the client's ai.users / ai.actions namespaces are thin wrappers over this.
export const setBucketLimits = mutation({
  args: {
    actorId: v.optional(v.string()),
    dimension: v.string(),
    value: v.string(),
    requestsPerMinute: v.optional(v.union(v.number(), v.null())),
    maxConcurrent: v.optional(v.union(v.number(), v.null())),
    dailySpendLimitNanos: v.optional(v.union(v.number(), v.null())),
    monthlySpendLimitNanos: v.optional(v.union(v.number(), v.null())),
    lifetimeSpendLimitNanos: v.optional(v.union(v.number(), v.null())),
    dailyTokenLimit: v.optional(v.union(v.number(), v.null())),
    monthlyTokenLimit: v.optional(v.union(v.number(), v.null())),
    lifetimeTokenLimit: v.optional(v.union(v.number(), v.null())),
    warnAtPct: v.optional(v.union(v.number(), v.null())),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"), v.null())),
    blocked: v.optional(v.union(v.boolean(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "setBucketLimits", args);
    assertAmount(args.requestsPerMinute, "requestsPerMinute");
    assertAmount(args.maxConcurrent, "maxConcurrent");
    assertAmount(args.dailySpendLimitNanos, "dailySpendLimitNanos");
    assertAmount(args.monthlySpendLimitNanos, "monthlySpendLimitNanos");
    assertAmount(args.lifetimeSpendLimitNanos, "lifetimeSpendLimitNanos");
    assertAmount(args.dailyTokenLimit, "dailyTokenLimit");
    assertAmount(args.monthlyTokenLimit, "monthlyTokenLimit");
    assertAmount(args.lifetimeTokenLimit, "lifetimeTokenLimit");
    assertFraction(args.warnAtPct, "warnAtPct");
    const bucket = await getOrCreateBucket(ctx, args.dimension, args.value, true);
    const { dimension: _d, value: _v, actorId: _actor, ...limits } = args;
    assertKey(args.dimension, "dimension", 64);
    assertKey(args.value, "value");
    const patch = Object.fromEntries(
      Object.entries(limits).filter(([, value]) => value !== undefined).map((
        [key, value],
      ) => [key, value === null ? undefined : value]),
    );
    await ctx.db.patch(bucket._id, patch);
    const updated = (await ctx.db.get(bucket._id))!;
    await syncPolicy(ctx, updated);
    // New empty buckets need no scan. Existing uncapped buckets must catch up
    // before admission can trust their counters or maxConcurrent.
    if (!needsReserve(bucket) && needsReserve(updated)) {
      const pending = await attributedRequests(ctx, bucket.dimension, bucket.value, null);
      const deltas = await ctx.db.query("usageDeltas").withIndex(
        "dim_value",
        q => q.eq("dimension", bucket.dimension).eq("value", bucket.value),
      ).take(1);
      if (
        deltas.length || pending.page.some(r => r.status === "pending" || r.settled === false)
        || !pending.isDone
      ) {
        const policy = (await ctx.db.query("bucketPolicies").withIndex("dim_value", q =>
          q.eq("dimension", bucket.dimension).eq("value", bucket.value)).unique())!;
        await ctx.db.patch(policy._id, { reconciling: true });
        await ctx.scheduler.runAfter(0, internal.lib.reconcileBucket, {
          bucketId: bucket._id,
          cursor: null,
        });
      }
    }
    return null;
  },
});

async function attributedRequests(
  ctx: MutationCtx,
  dimension: string,
  value: string,
  cursor: string | null,
) {
  const options = { cursor, numItems: RECONCILE_BATCH };
  const db = paginator(ctx.db, schema);
  if (dimension === USER_DIM) {
    return db.query("requests").withIndex("userId", q => q.eq("userId", value)).paginate(options);
  }
  if (dimension === ACTION_DIM) {
    return db.query("requests").withIndex("actionName", q => q.eq("actionName", value)).paginate(
      options,
    );
  }
  const tags = await db.query("requestTags").withIndex(
    "dim_value",
    q => q.eq("dimension", dimension).eq("value", value),
  ).paginate(options);
  const requests = await Promise.all(tags.page.map(t => ctx.db.get(t.requestId)));
  return { ...tags, page: requests.filter((r): r is Doc<"requests"> => r !== null) };
}

export const reconcileBucket = internalMutation({
  args: { bucketId: v.id("buckets"), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { bucketId, cursor }) => {
    const initial = await ctx.db.get(bucketId);
    if (!initial) return null;
    const policy = await ctx.db.query("bucketPolicies").withIndex(
      "dim_value",
      q => q.eq("dimension", initial.dimension).eq("value", initial.value),
    ).unique();
    if (!policy?.reconciling) return null;
    const deltas = await ctx.db.query("usageDeltas").withIndex(
      "dim_value",
      q => q.eq("dimension", initial.dimension).eq("value", initial.value),
    ).take(RECONCILE_BATCH);
    for (const d of deltas) await drainDelta(ctx, d);
    if (deltas.length === RECONCILE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.lib.reconcileBucket, { bucketId, cursor });
      return null;
    }
    const page = await attributedRequests(ctx, initial.dimension, initial.value, cursor);
    for (const req of page.page) {
      if (req.settled === false) {
        await foldOne(ctx, req);
        continue;
      }
      if (
        req.status !== "pending" || req.reservationReleased || !needsReserve(initial)
        || req.heldBucketIds?.includes(bucketId)
      ) continue;
      const original = req.attributedBuckets?.find(t =>
        t.dimension === initial.dimension && t.value === initial.value
      );
      const deletion = await deletionOf(ctx, initial.dimension, initial.value);
      if (
        original
          ? original.bucketId !== bucketId
          : deletion && req._creationTime <= deletion._creationTime
      ) continue;
      const b = (await ctx.db.get(bucketId))!;
      const today = dayStamp(), month = monthStamp();
      const n = normalizedBucket(b, today, month);
      const day = req.reservationDay ?? new Date(req._creationTime).toISOString().slice(0, 10);
      const m = req.reservationMonth ?? day.slice(0, 7);
      const cost = req.estimatedNanos ?? 0, tokens = req.estimatedTokens ?? 0;
      await ctx.db.patch(
        bucketId,
        checkedAccounting({
          ...windowResets(b, today, month),
          dayStamp: today,
          monthStamp: month,
          spendTodayNanos: n.spendTodayNanos,
          tokensToday: n.tokensToday,
          spendThisMonthNanos: n.spendThisMonthNanos,
          tokensThisMonth: n.tokensThisMonth,
          reservedTodayNanos: (n.reservedTodayNanos ?? 0) + (day === today ? cost : 0),
          reservedMonthNanos: (n.reservedMonthNanos ?? 0) + (m === month ? cost : 0),
          reservedTotalNanos: (b.reservedTotalNanos ?? 0) + cost,
          reservedTodayTokens: (n.reservedTodayTokens ?? 0) + (day === today ? tokens : 0),
          reservedMonthTokens: (n.reservedMonthTokens ?? 0) + (m === month ? tokens : 0),
          reservedTotalTokens: (b.reservedTotalTokens ?? 0) + tokens,
          pendingCount: (b.pendingCount ?? 0) + 1,
        }),
      );
      await ctx.db.patch(req._id, { heldBucketIds: [...(req.heldBucketIds ?? []), bucketId] });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.lib.reconcileBucket, {
        bucketId,
        cursor: page.continueCursor,
      });
    } else await ctx.db.patch(policy._id, { reconciling: false });
    return null;
  },
});

const vBumpArgs = {
  actorId: v.optional(v.string()),
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
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "bumpBucket", args);
    const { dimension, value, dailyNanos, monthlyNanos, lifetimeNanos } = args;
    assertAmount(dailyNanos, "dailyNanos");
    assertAmount(monthlyNanos, "monthlyNanos");
    assertAmount(lifetimeNanos, "lifetimeNanos");
    const bucket = await getOrCreateBucket(ctx, dimension, value);
    const today = dayStamp();
    const month = monthStamp();
    const curDaily = bucket.bumpDayStamp === today ? bucket.dailyBumpNanos ?? 0 : 0;
    const curMonthly = bucket.bumpMonthStamp === month ? bucket.monthlyBumpNanos ?? 0 : 0;
    await ctx.db.patch(
      bucket._id,
      checkedAccounting({
        bumpDayStamp: today,
        dailyBumpNanos: curDaily + (dailyNanos ?? 0),
        bumpMonthStamp: month,
        monthlyBumpNanos: curMonthly + (monthlyNanos ?? 0),
        lifetimeBumpNanos: (bucket.lifetimeBumpNanos ?? 0) + (lifetimeNanos ?? 0),
      }),
    );
    return null;
  },
});

// Manually credit or debit a bucket (comp a user, correct an overcharge).
// Negative deltaNanos = credit/refund, positive = extra charge. Adjusts the
// live day/month/lifetime windows AND the durable usage history, and records an
// audit row. Does not touch the global sharded total or reservations.
export const adjustBucket = mutation({
  args: {
    actorId: v.optional(v.string()),
    dimension: v.string(),
    value: v.string(),
    deltaNanos: v.number(),
    tokens: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "adjustBucket", args);
    const { dimension, value, deltaNanos, tokens } = args;
    // Bound the stored reason so the adjustments row can't approach the doc limit.
    const reason = args.reason === undefined ? undefined : truncate(args.reason, MAX_REASON);
    assertAmount(deltaNanos, "deltaNanos", { signed: true });
    assertAmount(tokens, "tokens", { signed: true });
    const b = await getOrCreateBucket(ctx, dimension, value);
    const today = dayStamp();
    const month = monthStamp();
    const dSame = b.dayStamp === today;
    const mSame = b.monthStamp === month;
    const dt = tokens ?? 0;
    // Gross-plus-credits ledger: a positive delta is a real extra charge (adds
    // to GROSS spend); a negative delta is a credit/refund that accrues to a
    // separate credits balance and NEVER reduces gross spend — so gross spend
    // and durable history stay consistent, and net = gross - credits. Credits
    // grant headroom because admission subtracts them from the cap check.
    const debit = deltaNanos > 0 ? deltaNanos : 0;
    const credit = deltaNanos < 0 ? -deltaNanos : 0;
    await ctx.db.patch(
      b._id,
      checkedAccounting({
        totalSpendNanos: b.totalSpendNanos + debit,
        totalTokens: Math.max(0, b.totalTokens + dt),
        dayStamp: today,
        monthStamp: month,
        spendTodayNanos: (dSame ? b.spendTodayNanos : 0) + debit,
        tokensToday: Math.max(0, (dSame ? b.tokensToday ?? 0 : 0) + dt),
        spendThisMonthNanos: (mSame ? b.spendThisMonthNanos ?? 0 : 0) + debit,
        tokensThisMonth: Math.max(0, (mSame ? b.tokensThisMonth ?? 0 : 0) + dt),
        creditsNanos: (b.creditsNanos ?? 0) + credit,
        creditsTodayNanos: (dSame ? b.creditsTodayNanos ?? 0 : 0) + credit,
        creditsThisMonthNanos: (mSame ? b.creditsThisMonthNanos ?? 0 : 0) + credit,
        // Advancing the window here must also clear the OLD window's reserved
        // holds, or an in-flight request from the previous day/month would be
        // treated as reserving against the new window and its later release would
        // no longer match — stranding those reserved nanos/tokens.
        ...(dSame ? {} : { reservedTodayNanos: 0, reservedTodayTokens: 0 }),
        ...(mSame ? {} : { reservedMonthNanos: 0, reservedMonthTokens: 0 }),
      }),
    );
    await ctx.db.insert("adjustments", { dimension, value, deltaNanos, tokens: dt, reason });
    // Durable history tracks GROSS spend only (debits); credits live in the
    // adjustments log + bucket balance, so usage rollups never go negative.
    await addUsage(ctx, dimension, value, "day", today, debit, dt, 0);
    await addUsage(ctx, dimension, value, "month", month, debit, dt, 0);
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
      .take(pageSize(limit, 50)),
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
        q.eq("dimension", dimension).eq("value", value).eq("period", period))
      .order("desc")
      .take(pageSize(limit, 90)),
});

// Deployment-wide default threshold for approaching-limit alerts (fraction of a
// cap, e.g. 0.8). Buckets can override with their own warnAtPct.
export const setAlertDefaults = mutation({
  args: { actorId: v.optional(v.string()), warnAtPct: v.optional(v.union(v.number(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "setAlertDefaults", args);
    const { warnAtPct } = args;
    assertFraction(warnAtPct, "warnAtPct");
    const existing = await getSettings(ctx);
    if (existing) {
      await ctx.db.patch(
        existing._id,
        checkedAccounting({ defaultWarnAtPct: warnAtPct ?? undefined }),
      );
    } else {await ctx.db.insert("settings", {
        key: "singleton",
        defaultWarnAtPct: warnAtPct ?? undefined,
      });}
    return null;
  },
});

// Deployment-wide data/pricing policy. Only the fields you pass change.
// - allowUnpricedModels: false rejects models with no configured price under
//   hard enforcement (default true — charge the conservative fallback).
// - storeContent: false stops persisting prompt/response content on request
//   rows (default true).
export const setDeploymentPolicy = mutation({
  args: {
    actorId: v.optional(v.string()),
    allowUnpricedModels: v.optional(v.boolean()),
    requireExplicitReservations: v.optional(v.boolean()),
    storeContent: v.optional(v.boolean()),
    storeRawErrors: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "setDeploymentPolicy", args);
    const patch: Record<string, unknown> = {};
    if ("requireExplicitReservations" in args) {
      patch.requireExplicitReservations = args.requireExplicitReservations;
    }
    if ("allowUnpricedModels" in args) patch.allowUnpricedModels = args.allowUnpricedModels;
    if ("storeRawErrors" in args) patch.storeRawErrors = args.storeRawErrors;
    if ("storeContent" in args) patch.storeContent = args.storeContent;
    const existing = await getSettings(ctx);
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("settings", { key: "singleton", ...patch });
    return null;
  },
});

// Privacy erasure and budget closure are separate from final provider billing.
const DELETE_BATCH = 25;
async function deleteBucketWork(ctx: MutationCtx, dimension: string, value: string) {
  let deletion = await deletionOf(ctx, dimension, value);
  if (!deletion) {
    const id = await ctx.db.insert("deletions", { dimension, value, deleting: true });
    deletion = (await ctx.db.get(id))!;
  }
  const currentBucket = await getBucketDoc(ctx, dimension, value);
  if (!deletion.deleting && currentBucket) {
    await ctx.db.delete(deletion._id);
    const id = await ctx.db.insert("deletions", { dimension, value, deleting: true });
    deletion = (await ctx.db.get(id))!;
  }
  if (!deletion.deleting) return { deletedThisBatch: 0, done: true };
  let count = 0, more = false;
  if (dimension === USER_DIM) {
    const rows = await ctx.db.query("requests").withIndex("userId", q => q.eq("userId", value))
      .take(DELETE_BATCH);
    for (const r of rows) {
      if (r.settled === false) await foldOne(ctx, r);
      await deleteRequestTags(ctx, r._id);
      if (r.status === "pending" || r.reservationExpired) {
        await releaseReservation(ctx, r);
        await ctx.db.patch(r._id, {
          userId: `erased:${r._id}`,
          messages: [],
          responseText: undefined,
          error: "account_deleted",
          privacyErased: true,
          contentPurged: true,
          reservationReleased: true,
          reservationExpired: true,
          expiredAt: Date.now(),
          status: "error",
          settled: true,
          expiresAt: undefined,
          attributedBuckets: r.attributedBuckets?.filter(t => t.dimension !== USER_DIM),
        });
      } else await ctx.db.delete(r._id);
      count++;
    }
    more ||= rows.length === DELETE_BATCH;
    const keys = await ctx.db.query("admissionKeys").withIndex(
      "user_key",
      q => q.eq("userId", value),
    ).take(DELETE_BATCH);
    for (const key of keys) {
      await ctx.db.delete(key._id);
      count++;
    }
    more ||= keys.length === DELETE_BATCH;
  }
  const deltas = await ctx.db.query("usageDeltas").withIndex(
    "dim_value",
    q => q.eq("dimension", dimension).eq("value", value),
  ).take(DELETE_BATCH);
  for (const d of deltas) {
    await ctx.db.delete(d._id);
    count++;
  }
  more ||= deltas.length === DELETE_BATCH;
  // NOTE: adminEvents are deliberately NOT deleted here. They are the audit
  // trail of admin actions on this bucket — including the deleteBucket event
  // itself (written by auditAdmin just before this runs). Sweeping them would
  // make the single most sensitive op unauditable and let anyone erase a
  // bucket's admin history by deleting it. The audit log is retained for
  // accountability. (Content/usage/credits ARE erased below; the audit of who
  // changed limits/credits and who deleted the bucket is the record that must
  // survive. For strict erasure of an identifier from the audit trail, scrub
  // or anonymize adminEvents separately — do not auto-delete them here.)
  const adjustments = await ctx.db.query("adjustments").withIndex(
    "dim_value",
    q => q.eq("dimension", dimension).eq("value", value),
  ).take(DELETE_BATCH);
  for (const d of adjustments) {
    await ctx.db.delete(d._id);
    count++;
  }
  more ||= adjustments.length === DELETE_BATCH;
  const history = await ctx.db.query("usage").withIndex(
    "bucket_period_stamp",
    q => q.eq("dimension", dimension).eq("value", value),
  ).take(DELETE_BATCH);
  for (const d of history) {
    await ctx.db.delete(d._id);
    count++;
  }
  more ||= history.length === DELETE_BATCH;
  const bucket = await getBucketDoc(ctx, dimension, value);
  if (bucket) {
    const policy = await ctx.db.query("bucketPolicies").withIndex(
      "dim_value",
      q => q.eq("dimension", dimension).eq("value", value),
    ).unique();
    if (policy) await ctx.db.delete(policy._id);
    await requestRateLimiter.reset(ctx, "requests", { key: bucket._id });
    await ctx.db.delete(bucket._id);
    count++;
  }
  if (more) await ctx.scheduler.runAfter(0, internal.lib.deleteBucketBatch, { dimension, value });
  else await ctx.db.patch(deletion._id, { deleting: false });
  return { deletedThisBatch: count, done: !more };
}
const deleteArgs = { actorId: v.optional(v.string()), dimension: v.string(), value: v.string() };
const deleteResult = v.object({ deletedThisBatch: v.number(), done: v.boolean() });
export const deleteBucket = mutation({
  args: deleteArgs,
  returns: deleteResult,
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "deleteBucket", args);
    return deleteBucketWork(ctx, args.dimension, args.value);
  },
});
export const deleteBucketBatch = internalMutation({
  args: deleteArgs,
  returns: deleteResult,
  handler: (ctx, { dimension, value }) => deleteBucketWork(ctx, dimension, value),
});

export const getModelPolicy = query({
  args: {},
  returns: v.object({
    mode: v.union(
      v.literal("open"),
      v.literal("allowlist"),
      v.literal("denylist"),
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
    enforcement: v.union(v.literal("approximate"), v.literal("hard"), v.literal("soft")),
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
      enforcement: s?.globalEnforcement ?? "approximate",
      // Prefer the reconciler-maintained reporting day so this query is reactive
      // (no wall-clock read that would freeze the day boundary in a subscription).
      spentTodayNanos: await globalSpend.count(ctx, globalDayKey(s?.reportingDay ?? dayStamp())),
      spentTotalNanos: await globalSpend.count(ctx, GLOBAL_TOTAL),
      retentionMs: s?.retentionMs ?? null,
      defaultWarnAtPct: s?.defaultWarnAtPct ?? null,
    };
  },
});

export const setGlobalLimits = mutation({
  args: {
    actorId: v.optional(v.string()),
    // Absent = leave unchanged; explicit null = clear that limit. (A bare
    // v.optional(number) that always rebuilt the full patch would let a
    // one-field edit — exactly what the dashboard sends — silently wipe the
    // other global controls by patching them to undefined.)
    dailySpendLimitNanos: v.optional(v.union(v.number(), v.null())),
    lifetimeSpendLimitNanos: v.optional(v.union(v.number(), v.null())),
    enforcement: v.optional(
      v.union(v.literal("approximate"), v.literal("hard"), v.literal("soft"), v.null()),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "setGlobalLimits", args);
    if (typeof args.dailySpendLimitNanos === "number") {
      assertAmount(args.dailySpendLimitNanos, "dailySpendLimitNanos");
    }
    if (typeof args.lifetimeSpendLimitNanos === "number") {
      assertAmount(args.lifetimeSpendLimitNanos, "lifetimeSpendLimitNanos");
    }
    // The settings fields are "global"-prefixed; map the friendly arg names,
    // touching ONLY the keys the caller actually passed. null -> clear.
    const patch: Record<string, unknown> = {};
    if ("dailySpendLimitNanos" in args) {
      patch.globalDailySpendLimitNanos = args.dailySpendLimitNanos ?? undefined;
    }
    if ("lifetimeSpendLimitNanos" in args) {
      patch.globalLifetimeSpendLimitNanos = args.lifetimeSpendLimitNanos ?? undefined;
    }
    if ("enforcement" in args) {
      patch.globalEnforcement = args.enforcement ?? undefined;
    }
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
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "bumpGlobal", args);
    const { dailyNanos, lifetimeNanos } = args;
    assertAmount(dailyNanos, "dailyNanos");
    assertAmount(lifetimeNanos, "lifetimeNanos");
    const today = dayStamp();
    const s = await getSettings(ctx);
    const curDaily = s?.globalBumpDayStamp === today ? s?.globalDailyBumpNanos ?? 0 : 0;
    const patch = {
      globalBumpDayStamp: today,
      globalDailyBumpNanos: curDaily + (dailyNanos ?? 0),
      globalLifetimeBumpNanos: (s?.globalLifetimeBumpNanos ?? 0) + (lifetimeNanos ?? 0),
    };
    checkedAccounting(patch);
    if (s) await ctx.db.patch(s._id, patch);
    else await ctx.db.insert("settings", { key: "singleton", ...patch });
    return null;
  },
});

export const setModelPolicy = mutation({
  args: {
    actorId: v.optional(v.string()),
    mode: v.union(
      v.literal("open"),
      v.literal("allowlist"),
      v.literal("denylist"),
    ),
    models: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "setModelPolicy", args);
    // Bound the list so the settings doc can't be pushed toward the 1 MiB limit.
    const models = args.models.slice(0, MAX_MODELS).map((m) => m.slice(0, MAX_MODEL_LEN));
    const existing = await getSettings(ctx);
    if (existing) {
      await ctx.db.patch(
        existing._id,
        checkedAccounting({
          modelMode: args.mode,
          models,
        }),
      );
    } else {
      await ctx.db.insert("settings", {
        key: "singleton",
        modelMode: args.mode,
        models,
      });
    }
    return null;
  },
});

export const setPrice = mutation({
  args: {
    actorId: v.optional(v.string()),
    model: v.string(),
    inputNanosPerMTok: v.number(),
    outputNanosPerMTok: v.number(),
    // optional cache-read rate; if omitted, a default discount off input applies
    cachedNanosPerMTok: v.optional(v.number()),
    cacheWriteNanosPerMTok: v.optional(v.number()),
    cacheWrite1hNanosPerMTok: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "setPrice", args);
    // Negative prices would make costOf return a negative cost, which folds
    // into totals as a spend *refund* — pushing a user back under their cap.
    // NaN/Infinity (allowed by v.number()) are just as corrupting — a NaN rate
    // poisons every settled cost for the model — so require finite integers.
    assertAmount(args.inputNanosPerMTok, "inputNanosPerMTok");
    assertAmount(args.outputNanosPerMTok, "outputNanosPerMTok");
    assertAmount(args.cachedNanosPerMTok, "cachedNanosPerMTok");
    assertAmount(args.cacheWriteNanosPerMTok, "cacheWriteNanosPerMTok");
    assertAmount(args.cacheWrite1hNanosPerMTok, "cacheWrite1hNanosPerMTok");
    const { actorId: _actor, ...price } = args;
    const existing = await ctx.db
      .query("prices")
      .withIndex("model", (q) => q.eq("model", args.model))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, price);
    } else {
      await ctx.db.insert("prices", price);
    }
    return null;
  },
});

export const listPrices = query({
  args: {},
  handler: async (ctx) => {
    const overrides = await ctx.db.query("prices").take(2000);
    const merged: Record<
      string,
      {
        input: number;
        output: number;
        cached?: number;
        cacheWrite?: number;
        cacheWrite1h?: number;
        overridden: boolean;
      }
    > = {};
    for (const [model, p] of Object.entries(DEFAULT_PRICES)) {
      merged[model] = { ...p, overridden: false };
    }
    for (const o of overrides) {
      merged[o.model] = {
        input: o.inputNanosPerMTok,
        output: o.outputNanosPerMTok,
        cached: o.cachedNanosPerMTok,
        cacheWrite: o.cacheWriteNanosPerMTok,
        cacheWrite1h: o.cacheWrite1hNanosPerMTok,
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
    const s = await getSettings(ctx);
    return { ...DEFAULT_SERVER_TOOL_PRICES, ...(s?.serverToolPrices ?? {}) };
  },
});

export const setServerToolPrice = mutation({
  args: { actorId: v.optional(v.string()), tool: v.string(), nanosPerCall: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await auditAdmin(ctx, "setServerToolPrice", args);
    const { tool, nanosPerCall } = args;
    assertKey(tool, "tool", 64);
    assertAmount(nanosPerCall, "nanosPerCall");
    const s = await getSettings(ctx);
    const serverToolPrices = { ...(s?.serverToolPrices ?? {}), [tool]: nanosPerCall };
    if (Object.keys(serverToolPrices).length > MAX_SERVER_TOOLS) {
      throw new Error("Too many server-tool prices");
    }
    if (s) await ctx.db.patch(s._id, { serverToolPrices });
    else await ctx.db.insert("settings", { key: "singleton", serverToolPrices });
    return null;
  },
});
