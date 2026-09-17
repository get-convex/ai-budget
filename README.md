# ☂️ @convex-dev/ai-budget

**Add this component and get worry-free AI.** A metered, budget-governed layer
over the [Convex AI Gateway](https://docs.convex.dev/ai-gateway/overview). Point
your LLM calls through it and every request is tracked, priced, attributed, and
held to a budget — with atomic admission that accounts for concurrent load.

```ts
// userId defaults to the signed-in user — this is the whole integration:
const { text, costNanos } = await ai.chat(ctx, { prompt });
```

That one call is authenticated to the gateway with a short-lived deployment
token (no API keys to manage), attributed to the authenticated user, checked
against their limits, billed to the right user and feature, and written to a
full audit log you can replay later.

![Chat with a live request log — every call tracked, priced, and attributed](docs/hero.png)

## Contents

- [Features](#features)
- [Setup](#setup)
- [Quickstart](#quickstart)
- [Concepts](#concepts) — dimensions, nanodollars, reserve→settle
- [Generating text](#generating-text) — `chat`, `languageModel`, replay
- [Budgets & limits](#budgets--limits) — set caps, bumps, credits, alerts
- [Monitoring](#monitoring) — totals, spend history, the request log
- [Deployment-wide controls](#deployment-wide-controls) — global cap, model policy, pricing, retention
- [Admin dashboard](#admin-dashboard)
- [How spend caps stay correct](#how-spend-caps-stay-correct) — the design
- [Security](#security-before-you-ship)
- [Example app](#example-app)
- [Development](#development)

---

## Features

| | |
|---|---|
| **Usage & cost tracking** | Every request stored with messages, response, tokens, latency, and per-request cost. |
| **Attribution** | Each call is attributed to a `userId` **and** the Convex action that made it — auto-detected via `ctx.meta`, no manual tagging. |
| **Tagged budgets** | `user` and `action` are just built-in *dimensions* — add your own (team, project, customer, env…) via `tags`, and cap any of them. One request can be billed to several buckets at once. |
| **Spend & token limits** | Per-bucket **daily / monthly / lifetime** spend and token budgets, plus requests-per-minute, a max-concurrent cap, and a block switch. |
| **Concurrency-safe admission** | A reserve-then-settle design makes admission atomic against estimated usage, so concurrent requests can't all spend the same remaining budget. Final usage can exceed its reservation; the actual amount is recorded at settlement. |
| **Hard or soft** | Each limit either **blocks** (`hard`) or **allows-with-a-warning** (`soft`). |
| **Approaching-limit alerts** | Set `warnAtPct` (e.g. 0.8) and get an `onThreshold` callback before a cap is hit; `onLimitReached` fires when one blocks. |
| **Spend history** | Durable per-bucket **daily & monthly** rollups that survive request retention — real spend-over-time, per user / action / tag. |
| **Manual credits/debits** | Comp a user or correct an overcharge with a signed adjustment, recorded to the live windows, the history, and an audit log. |
| **One-time bumps** | "Approve another $X" without changing the standing cap — bucket daily/monthly bumps and global daily bumps reset with their windows; lifetime bumps persist. |
| **Global killswitch** | A deployment-wide spend cap across everything (sharded for throughput; enforced approximately). |
| **Authoritative cost** | Records the gateway's **real** per-request dollar cost when available; otherwise cache-aware token pricing. Unknown models **fail closed** (charged a conservative max, never $0). |
| **Model policy** | Allow/deny lists for models. |
| **Replay** | Re-run any stored request with edited messages or a different model; re-runs are linked to their original (lineage). |
| **Agent-ready** | `ai.languageModel(ctx, { userId })` is a standard AI SDK model — drop it into [`@convex-dev/agent`](https://www.npmjs.com/package/@convex-dev/agent) and every generation is budgeted. |
| **Built-in dashboard** | `ai.registerRoutes(http)` mounts a self-contained admin dashboard at a URL — one line, no UI to build. |

---

## Setup

Requires `convex@^1.45`, the AI SDK, and a Convex team on a paid plan (the
gateway is a paid feature). Runs in Convex's **default runtime** — no
`"use node"` (the component is pure V8; `ai.chat` / `ai.languageModel` are
`fetch`-based).

**1. Install**

```sh
npm install @convex-dev/ai-budget @convex-dev/ai-sdk-provider ai
```

**2. Register the component**

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import aiBudget from "@convex-dev/ai-budget/convex.config";

const app = defineApp();
app.use(aiBudget);
export default app;
```

**3. Create a client**

```ts
// convex/ai.ts
import { AIBudget } from "@convex-dev/ai-budget";
import { components } from "./_generated/api";

export const ai = new AIBudget(components.aiBudget, {
  defaultModel: "openai/gpt-4o-mini",
  onSoftLimit: ({ userId, messages }) => console.warn(userId, messages),
});
```

`ai.chat` and `ai.languageModel` are top-level; everything else is namespaced —
`ai.users.*`, `ai.actions.*`, `ai.tag(d).*`, `ai.global.*`, `ai.models.*`,
`ai.prices.*`, `ai.requests.*`.

---

## Quickstart

```ts
// convex/ai.ts
import { v } from "convex/values";
import { action } from "./_generated/server";

export const sendMessage = action({
  args: { prompt: v.string() },
  handler: async (ctx, { prompt }) => {
    // userId defaults to the authenticated caller (ctx.auth). Limit-checked,
    // tracked, priced. Throws a ConvexError if over a hard cap.
    const { text, costNanos, warnings } = await ai.chat(ctx, { prompt });
    return { text, costNanos, warnings };
  },
});
```

Give someone a budget:

```ts
await ai.users.setLimits(ctx, {
  userId: "alice",
  dailySpendLimitNanos: 1_000_000_000, // $1.00 / day
  dailyTokenLimit: 500_000,
  requestsPerMinute: 20,
});
```

When a request would exceed a **hard** cap, `chat` throws a `ConvexError`
carrying `{ kind: "AIBudgetLimit", code, reason }`; the attempt is still recorded
(`status: "blocked"`) so you can see who's hitting limits.

---

## Concepts

Three ideas make the rest of the API obvious.

**Dimensions & buckets.** Spend is attributed along *dimensions*. `user` and
`action` are built in (from `userId` and the calling Convex action); you can add
any others — `team`, `customer`, `env`, `feature` — by passing `tags`. Each
`(dimension, value)` pair is a **bucket** with its own totals and optional caps.
`ai.users`, `ai.actions`, and `ai.tag("customer")` are the *same* API over
different dimensions.

**Nanodollars.** All money is integer **nanodollars** (`1 USD = 1e9 nano`) —
costs, limits, prices. Integers avoid the rounding drift floating-point cents
accumulate and keep cap comparisons exact (to ~$9M per value). `$1 = 1_000_000_000`.

**Reserve → settle.** Each request is admitted by an atomic check-and-reserve
of estimated usage against every capped bucket it touches, then settled to its
real cost when it finishes. That's what prevents concurrent requests from all
spending the same remaining budget — see
[How spend caps stay correct](#how-spend-caps-stay-correct).

> All methods are called from a Convex **action** (they run the gateway call),
> or a **query** for the read-only ones. `ctx` is the Convex context.

---

## Generating text

### `ai.chat` — one-shot completion

```ts
ai.chat(ctx, {
  userId?,     // defaults to the authenticated caller (ctx.auth)
  prompt?,     // or:
  messages?,   // [{ role, content }]
  model?,      // defaults to defaultModel
  action?,     // attribution name; defaults to the calling Convex action
  tags?,       // extra dimensions: [{ dimension: "customer", value: "acme" }, …]
}): Promise<{ text, requestId, costNanos, promptTokens, completionTokens, cachedTokens, warnings, notices }>
```

`warnings` is non-empty only when a **soft** limit was exceeded; `notices` when a
[threshold](#alerts) was crossed. If no `userId` is passed and there's no
authenticated user, `chat` throws — budgets are never silently un-attributed.

### `ai.languageModel` — an AI SDK model (Agent, generateText, streamText)

```ts
ai.languageModel(ctx, { userId?, model?, action?, tags? }): LanguageModel
```

A standard AI SDK `LanguageModel` that enforces the budget and records usage/cost
on every call, including streaming. Drop it into the Convex Agent:

```ts
import { Agent } from "@convex-dev/agent";

const agent = new Agent(components.agent, {
  name: "assistant",
  languageModel: ai.languageModel(ctx, { userId }),
});
const { threadId } = await agent.createThread(ctx, { userId });
const result = await agent.generateText(ctx, { threadId }, { prompt });
```

Every generation is now tracked and budgeted, attributed to `userId` and the
calling action. See `example/convex/agentDemo.ts`.

### `ai.meter` — budget *any* provider call

`chat`/`languageModel` go through the gateway. When you need something the
gateway can't serve (Anthropic web search, computer-use, a different provider,
a raw `fetch`), `meter` brings that call under the *same* caps, audit log, and
cost tracking. It reserves before your `run` (throwing over a hard cap), runs
it, and records the actual usage:

```ts
await ai.meter(ctx, { userId, model: "anthropic/claude-…", messages }, async () => {
  const res = await anthropic.messages.create({
    messages,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
  });
  return {
    text: extractText(res),
    promptTokens: res.usage.input_tokens,
    completionTokens: res.usage.output_tokens,
    cachedTokens: res.usage.cache_read_input_tokens ?? 0,
    serverToolUses: { web_search: res.usage.server_tool_use?.web_search_requests ?? 0 },
    // costNanos? — pass an authoritative total to skip token/tool pricing
  };
});
```

`chat` is sugar over `meter`. Return either a raw provider `usage` (auto-
normalized) or explicit `promptTokens`/`completionTokens`/`cachedTokens`, plus
optional `serverToolUses` (see [pricing](#pricing--cost)) and `costNanos`.

**Cost known up front (image gen, per-call APIs).** When you know the price
before the call — image generation (`n` × per-image), audio, anything per-call —
pass `estimatedCostNanos` so the *reservation* holds the real amount and a hard
cap is exact (the token estimate is meaningless for these). Price the units with
`serverToolUses` + [`setServerTool`](#pricing--cost):

```ts
const IMG = 130_000_000; // $0.13/image
await ai.meter(ctx,
  { userId, model: "openai/gpt-image-1", messages: [{ role: "user", content: prompt }],
    estimatedCostNanos: IMG * n },
  async () => {
    const res = await openrouter.images.generate({ model: "openai/gpt-image-1", prompt, n });
    return { serverToolUses: { image: n } };   // priced via setServerTool({ tool: "image", … })
  });
```

### `ai.begin` / `ai.settle` — long async jobs (video)

A video job is submit → wait minutes → poll/webhook → done, spanning multiple
Convex functions, so the synchronous `meter` bracket doesn't fit. Reserve with
`begin` at submit, `settle` from the later context. Set `reserveTtlMs` to the
job's max duration so the reconciler doesn't reap the hold mid-flight:

```ts
// submit (action): reserve, then kick off the job
const started = await ai.begin(ctx, {
  userId, model: "openai/sora",
  estimatedCostNanos: perSecond * seconds,
  reserveTtlMs: 20 * 60 * 1000,          // hold up to 20 min
});
if (!started.allowed) throw new ConvexError(started.reason);
const job = await sora.videos.create({ … });
await ctx.db.insert("videoJobs", { requestId: started.requestId, jobId: job.id });

// later — settle from a poll, or a provider webhook:
ai.registerWebhook(http, {
  path: "/aibudget/video-done",
  resolve: async (ctx, request, body) => {
    if (!verifySignature(request, body)) return null;             // 202, ignored
    const job = await lookupJob(ctx, body.id);                    // → { requestId }
    return { requestId: job.requestId, serverToolUses: { video_seconds: body.seconds } };
  },
});
```

`begin` returns the admission result (it doesn't throw — check `allowed`).
`settle` is idempotent (exactly-once server-side), so a retried webhook is safe.
The webhook resolver receives the original, unread `Request`, allowing signature
verification over the exact raw body; the parsed JSON comes from a clone.

### Replay

```ts
ai.requests.rerun(ctx, { requestId, messages?, model? }): Promise<ChatResult>
ai.requests.lineage(ctx, { requestId }): Promise<{ ancestors, reruns }>
```

`rerun` re-runs a stored request (optionally with edited messages/model), linked
to the original and billed to its **original** user. `lineage` walks the re-run
chain in both directions.

---

## Budgets & limits

`ai.users`, `ai.actions`, and `ai.tag(dimension)` are the same namespace over
different dimensions. Each exposes:

| Method | |
|---|---|
| `list(ctx)` | every bucket in the dimension, with spend + caps |
| `get(ctx, { … })` | one bucket (null if it has none yet) |
| `setLimits(ctx, { …, ...limits })` | set/clear caps & controls |
| `bump(ctx, { …, dailyNanos?, monthlyNanos?, lifetimeNanos? })` | one-time headroom |
| `adjust(ctx, { …, deltaNanos, reason? })` | manual credit / debit |
| `history(ctx, { …, period })` | durable day/month spend history |
| `adjustments(ctx, { … })` | the manual-adjustment audit log |
| `delete(ctx, { … })` | remove the bucket (and, for `user`, its request rows) |

The identifier field is `userId` for `ai.users`, `name` for `ai.actions`, and
`value` for `ai.tag(d)`. For example: `ai.tag("customer").setLimits(ctx, { value: "acme", … })`.

### Request rate limits

`requestsPerMinute` uses `@convex-dev/rate-limiter` 0.4.0 with a transactional
**token bucket** for each user, action, or custom tag. A limit of 60 allows an
initial burst of 60 requests and then refills at one request per second, up to
60. Zero blocks all requests. Only admitted requests consume capacity: a budget,
concurrency, or another bucket's rate rejection consumes none.

This replaces the previous rolling 60-second request-log count. On upgrading,
rate balances start full; historical requests are not imported. Budget balances,
reservations, and spend history are preserved. Deploy the component update to
mount its nested Rate Limiter component; applications do not register it separately.
Changing a rate keeps its existing balance (clamped to the new capacity when
checked); deleting and recreating a bucket starts a fresh balance.

Rate limits remain transactional. Rate Limiter's asynchronous mode is not enabled
here because simultaneous admissions must respect every configured bucket.
Global spend accounting continues to use the existing sharded counter.

### Setting caps

```ts
ai.users.setLimits(ctx, {
  userId,                    // or `name` / `value` for actions / tags
  requestsPerMinute?,
  maxConcurrent?,            // max in-flight requests at once
  dailySpendLimitNanos?,
  monthlySpendLimitNanos?,   // calendar-month budget (UTC)
  lifetimeSpendLimitNanos?,
  dailyTokenLimit?,
  monthlyTokenLimit?,
  lifetimeTokenLimit?,
  warnAtPct?,                // e.g. 0.8 → alert at 80% of a cap
  enforcement?,              // "hard" (block, default) | "soft" (warn but allow)
  blocked?,                  // hard block on/off
})
```

Pass a field as `undefined` to clear that limit (unlimited). A request is
admitted only if its estimate fits **every** bucket it touches — the same atomic
reserve-then-settle admission check runs per bucket. Uncapped buckets never serialize, so
adding tags you don't cap is free at admission; their totals still accrue for
reporting.

### Tags — budgeting by any dimension

```ts
// Bill this call to a user, an action (implicit), AND a customer + env.
await ai.chat(ctx, {
  prompt,
  tags: [
    { dimension: "customer", value: "acme" },
    { dimension: "env", value: "prod" },
  ],
});

// Cap the customer "acme" to $50/day — independent of any per-user cap.
await ai.tag("customer").setLimits(ctx, {
  value: "acme",
  dailySpendLimitNanos: 50 * 1_000_000_000,
});
```

### One-time bumps

```ts
ai.users.bump(ctx, { userId, dailyNanos?, monthlyNanos?, lifetimeNanos? })
```

Adds headroom on top of the standing cap without changing it. Daily/monthly
bumps apply to the current window; lifetime bumps are permanent.

### Manual credits & debits

```ts
await ai.users.adjust(ctx, { userId, deltaNanos: -5 * 1_000_000_000, reason: "goodwill" });
await ai.users.adjustments(ctx, { userId });   // the audit log
```

Negative = credit, positive = extra charge; it adjusts the live day/month/lifetime
windows, the history, and an audit log.

### Alerts

Get a callback *before* a cap is hit, and when a hard cap blocks:

```ts
await ai.global.setAlertDefaults(ctx, { warnAtPct: 0.8 });   // 80%, all buckets
await ai.users.setLimits(ctx, { userId, warnAtPct: 0.9 });   // per-bucket override

new AIBudget(components.aiBudget, {
  onThreshold:    ({ userId, messages }) => notify(userId, messages),  // approaching
  onSoftLimit:    ({ userId, messages }) => notify(userId, messages),  // soft cap exceeded
  onLimitReached: ({ userId, reason })   => notify(userId, reason),    // hard cap blocked
});
```

`chat()` also returns `notices` (approaching) alongside `warnings` (soft-exceeded).

---

## Monitoring

### Lists & totals

```ts
ai.users.list(ctx)             // per-user spend today / month / total / limits
ai.actions.list(ctx)           // per-action spend & totals
ai.tag("customer").list(ctx)   // spend & caps for any custom dimension
```

### Spend history (survives retention)

Request rows are retained only briefly (see [retention](#retention)), but
**durable per-bucket day/month rollups are not** — so charts and "what did we
spend last month" keep working:

```ts
await ai.users.history(ctx, { userId, period: "month" });  // [{ stamp, spendNanos, tokens, requests }]
await ai.tag("customer").history(ctx, { value: "acme", period: "day", limit: 30 });
```

### The request log

```ts
ai.requests.list(ctx, { userId?, limit? })                        // audit log (blocked included)
ai.requests.list(ctx, { dimension: "customer", value: "acme" })   // filter by any tag
ai.requests.get(ctx, { requestId })                               // one request (full prompt + response)
```

---

## Deployment-wide controls

### Global cap

```ts
ai.global.setLimits(ctx, { dailySpendLimitNanos?, lifetimeSpendLimitNanos?, enforcement? })
ai.global.status(ctx)   // { limits, spentTodayNanos, spentTotalNanos, … }
ai.global.bump(ctx, { dailyNanos?, lifetimeNanos? })
```

A killswitch across everything. Backed by a sharded counter for throughput, so
it's enforced **approximately** (bounded concurrency overshoot under burst).
Per-bucket admission is atomic against each request's estimate.

### Model policy

```ts
ai.models.setPolicy(ctx, { mode, models })   // mode: "open" | "allowlist" | "denylist"
ai.models.getPolicy(ctx)
```

### Pricing & cost

The component records the gateway's **real per-request dollar cost** when the
provider surfaces it (`@convex-dev/ai-sdk-provider ≥ 0.2.0-alpha.1`, via
`providerMetadata.convexGateway.cost`) — cached and reasoning tokens included, so
recorded spend equals the actual bill. Without it, cost is computed from token
counts, discounting the cached slice (the gateway's real `cacheReadTokens`) at
`cachedNanosPerMTok` (default 10% of input). Either way, an **unknown model is
charged a conservative max, never $0** (so a cap can't be dodged by naming an
unlisted model) and its rows are flagged `unpricedModel: true`.

Prices are **nanodollars per million tokens**; sensible defaults ship for common
models. Override or add any model:

```ts
ai.prices.set(ctx, { model, inputNanosPerMTok, outputNanosPerMTok, cachedNanosPerMTok? })  // ≥ 0
ai.prices.list(ctx)
```

**Server tools.** Provider server-side tools bill a per-call fee on top of
tokens (e.g. Anthropic web search). Report them from `meter` as
`serverToolUses: { web_search: 3 }` and they're priced per call (default
$0.01/`web_search`) — unless you pass an authoritative `costNanos`, which already
includes them. Override the rate:

```ts
ai.prices.setServerTool(ctx, { tool: "web_search", nanosPerCall: 12_000_000 })
ai.prices.listServerTools(ctx)
```

The gateway's `provider/model` ids match OpenRouter's, whose public models
endpoint returns per-token pricing — so you can keep prices current from your own
action (see `example/convex/ai.ts` → `syncPrices`):

```ts
const { data } = await (await fetch("https://openrouter.ai/api/v1/models")).json();
const p = data.find((m) => m.id === "openai/gpt-4o-mini").pricing;
await ai.prices.set(ctx, {
  model: "openai/gpt-4o-mini",
  inputNanosPerMTok: Math.round(Number(p.prompt) * 1e15),      // $/token → nano/Mtok
  outputNanosPerMTok: Math.round(Number(p.completion) * 1e15),
});
```

### Retention

```ts
ai.global.setRetention(ctx, { retentionMs })   // default 1h; 0 disables
```

Full request rows (prompts + responses) are swept after the window to bound the
audit table. **Spend history survives** — it lives in separate durable rollups.

---

## Admin dashboard

The component ships a self-contained admin dashboard — buckets & limits, the
request log, spend-over-time charts, and settings. Mount it with **one call**:

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { components } from "./_generated/api";
import { AIBudget } from "@convex-dev/ai-budget";

const ai = new AIBudget(components.aiBudget);
const http = httpRouter();

ai.registerRoutes(http, {
  // Gate it — the endpoint is public. Recommended: check the caller is an admin.
  authorize: async (ctx) => (await ctx.auth.getUserIdentity())?.role === "admin",
});

export default http;
```

It lives at `https://<deployment>.convex.site/aibudget` (override with `path`).
**It is a public internet endpoint, so you must gate it**: pass `authorize`
(return `true` to allow) or set `AI_BUDGET_DASHBOARD_TOKEN` (sent as
`Authorization: Bearer …`). With neither, every route returns 401. Everything the
page shows is backed by the component's own functions — nothing else to wire up.

---

## How spend caps stay correct

A naive tracker checks the running total, makes the call, then records the cost.
Under concurrency that leaks badly: dozens of in-flight requests all read the same
pre-spend total and all pass, so spend blows past the cap (measured at ~40× before
this design). `ai-budget` instead **reserves then settles**:

1. **Reserve.** `startRequest` estimates the request's cost/tokens and, *in the
   same transaction as the limit check*, reserves them against each capped bucket.
   Under Convex's serializable isolation this is a true atomic check-and-reserve —
   concurrent requests see each other's holds.
2. **Settle.** `finishRequest` writes only the request's own (uncontended) row and
   schedules a fold of the real cost into the totals, releasing the reservation —
   so a request is never orphaned mid-flight.
3. **Reconcile.** A once-a-minute cron folds any stragglers and releases
   expired reservations using indexed deadlines. Expiry releases the hold but
   leaves billing open: a late completion records its final charge once without
   releasing the hold again. After content retention, unresolved requests retain
   a small billing record with prompts and responses removed.

Requests record the exact bucket IDs and calendar windows they reserve.
Settlement cannot release another request's hold, including across midnight or
month boundaries. Admission reads separate policy documents; only capped buckets
require reads of accounting state. Reporting updates still share bucket totals,
but do not write the policy documents used by uncapped admission.

**One admission rule, all scopes.** Every per-bucket cap — user, action, or any
tag — runs through the *same* admission check: a request is admitted only when
`committed + reserved + estimate ≤ cap` (bumps included) for **every** bucket it
touches. Each per-bucket cap reserves on a single document, making concurrent
admission atomic. The **global** killswitch is backed by a sharded counter for
throughput. Its sum is transactional but excludes unfinished and not-yet-folded
requests and has no cross-request reservation, so global admissions can overshoot.
Global usage is recorded even when limits are disabled. Historical usage omitted
by older versions is not automatically reconstructed by this upgrade.

Reservations are estimates, not provider-side maximum charges. If a response uses
more tokens or costs more than estimated, settlement records the real amount and
the final total can exceed a hard cap by that request's estimation delta. The next
admission sees the settled total and blocks until there is headroom again.

The `error.md` file documents the adversarial audits this design survived, with
live repros.

---

## Security: before you ship

The component is deliberately **identity-agnostic** — like
`@convex-dev/rate-limiter`, it trusts the `userId` and admin calls your app hands
it. **Your app owns auth.** The `example/` app skips auth on purpose to keep the
demo frictionless (a persona dropdown, public admin functions); do not copy its
endpoints verbatim. In production:

1. **Let `userId` default to the authenticated caller** (the built-in behavior —
   `ai.chat(ctx, { prompt })` uses `ctx.auth.getUserIdentity()`). Only pass an
   explicit `userId` from a trusted server context; never forward a client-supplied
   id, or a caller can spend under someone else's budget or dodge their own limits
   by rotating ids.
2. **Gate every admin call** — `setLimits`, `bump`, `adjust`, `setModelPolicy`,
   `setPrice`, `delete` — behind an admin check. A limit-management surface must
   not be operable by the party being limited.
3. **Scope reads and replay to the owner.** `requests.list` / `requests.get` /
   `lineage` return full prompts, responses, and spend, and `rerun` re-runs a
   request billed to its **original** user. An unchecked client `requestId` is an
   IDOR — verify `request.userId === caller`, or treat those as admin-only.
4. **Gate the dashboard.** `registerRoutes` is a public endpoint; always pass a
   real `authorize` (or a token). See [Admin dashboard](#admin-dashboard).

---

## Example app

`example/` is a full working demo: chat as different personas on the left; a live
admin panel on the right — the request audit log (inspect → edit → re-run, with
lineage), a users table (limits, soft toggle, block, bump), per-action budgets,
and a **⚡ Burst** tab that fires N real concurrent AI requests against one
tightly-capped budget: watch reservations appear live, some requests get
admitted (with real settled costs), and the rest get atomically rejected by the
cap — the reserve-then-settle admission design, visible.

![Users & Limits admin table](docs/users.png)
![Actions & Budgets admin table](docs/actions.png)

```sh
cd example
npm install         # also links the repo-root node_modules the demo's
                    # ../../src component imports resolve through (postinstall)
npx convex dev      # terminal 1 — provisions a dev deployment
npm run dev         # terminal 2 — Vite app
```

### What's in the component vs. the demo

The published AI Budget component (`src/`) is **only** the metering/budget
primitive — it knows nothing about agents or evaluation. The example composes
three isolated pieces:

- The **Agent component** owns agent threads, messages, tools, and generation.
- The local **Evaluation component** (`example/convex/evaluations/`) owns immutable
  case snapshots, run lifecycle, and results. It does not call Agent or AI Budget.
- App-level adapters in `example/convex/ai.ts` compose the siblings: they obtain
  source traffic, run candidate/judge model calls through AI Budget, attach an
  `evalRun` budget tag, and persist outcomes into Evaluation.
- The **eval playground** (🧪 Experiment tab) exposes **Matrix** (one prompt across a
  system-prompt × model grid, ranked by an LLM judge on *your* criteria),
  **Backtest** (replay a candidate prompt against an action's real historical
  requests and judge each), and **Evolve** (an LLM iteratively improves a prompt
  toward a goal on real traffic, **stopping when it hits a spend budget**).

The demo currently snapshots AI Budget audit traffic as its corpus. An Agent-based
product should instead make the app adapter snapshot cases through Agent's public
API; Evaluation must never inspect Agent's private tables. The same Evaluation
component works with either source because its inputs are explicit snapshots.

This local component is a proof of the reusable boundary, not part of the
`@convex-dev/ai-budget` package. If productized, it should ship independently
(for example, `@convex-dev/evals`) and accept application adapters/function
handles rather than taking a dependency on either sibling component.

---


## Accounting upgrade notes

New request fields are optional for existing deployments. Policy documents are
created on first admission or limit update; pending requests without deadlines
are migrated in batches by reconciliation. Existing reservations without ownership
metadata use their creation period and current capped buckets as a compatibility
fallback. Exact historical hold ownership cannot be reconstructed if those caps
changed before the upgrade. New requests always store explicit ownership.

## Development

```sh
npm test            # vitest + convex-test: reserve/settle, exactly-once, monthly
                    # caps, cache pricing, tag budgets, alerts, adjustments, …
npm run build       # emit dist/ (client + component) for publishing
```

**Layout**

- `src/component/` — **the component** (published): tables (`buckets`, `requests`,
  `usage`, `requestTags`, `adjustments`, `prices`, `settings`), the reserve/settle
  mutations (`startRequest` / `finishRequest`), the idempotent `foldTotals`, the
  `reconcile` cron, and the admin functions. Mounts `@convex-dev/sharded-counter`
  for the global total.
- `src/client/` — **the client** (published): the `AIBudget` class — `chat`,
  `languageModel`, `registerRoutes`, and the namespaced admin API.
- `example/` — **the demo app** (not published): real features, the eval
  playground, and the UI. `example/convex/evaluations/` is a separate local
  component for datasets, runs, and results; `example/convex/ai.ts` is the
  composition layer.

## License

Apache-2.0
