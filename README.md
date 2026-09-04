# ☂️ @convex-dev/ai-budget

**Add this component and get worry-free AI.** A metered, budget-governed layer
over the [Convex AI Gateway](https://docs.convex.dev/ai-gateway/overview). Point
your LLM calls through it and every request is tracked, priced, attributed, and
held to a budget — with spend caps that actually hold under concurrent load.

```ts
// userId defaults to the signed-in user — this is the whole integration:
const { text, costNanos } = await ai.chat(ctx, { prompt });
```

That one call is authenticated to the gateway with a short-lived deployment
token (no API keys to manage), attributed to the authenticated user, checked
against their limits, billed to the right user and feature, and written to a
full audit log you can replay later.

![Chat with a live request log — every call tracked, priced, and attributed](docs/hero.png)

---

## What you get

| | |
|---|---|
| **Usage & cost tracking** | Every request stored with messages, response, tokens, latency, and per-request cost. |
| **Attribution** | Each call is attributed to a `userId` **and** to the Convex action that made it — auto-detected via `ctx.meta`, no manual tagging. Running totals per user and per action. |
| **Tagged budgets** | `user` and `action` are just built-in *dimensions* — add your own (team, project, customer, env, feature…) by passing `tags`, and cap any of them with `ai.tag("customer").setLimits(...)`. One request can be billed to several buckets at once. |
| **Spend & token limits** | Per-bucket **daily / monthly / lifetime** spend and token budgets, plus a requests-per-minute rate limit, a max-concurrent cap, and a block switch. |
| **Spend history** | Durable per-bucket **daily & monthly** rollups that survive request retention — real spend-over-time, "what did we spend last month," per user / action / tag. |
| **Approaching-limit alerts** | Set `warnAtPct` (e.g. 0.8) and get an `onThreshold` callback before a cap is hit; `onLimitReached` fires when one blocks. |
| **Manual credits/debits** | Comp a user or correct an overcharge with a signed adjustment; the change hits the live windows, the history, and an audit log. |
| **Cache-aware cost** | Cached (prompt-cache-read) tokens are billed at a discount using the gateway's real cached-token count — not the full input rate. |
| **Concurrency-safe caps** | A reserve-then-settle design makes admission a true atomic check — concurrent in-flight requests can't blow past the cap (a naive implementation overshoots ~40×). |
| **Hard or soft** | Each limit either **blocks** (`hard`) or **allows-with-a-warning** (`soft`). |
| **Per-feature budgets** | Cap or block a whole action (e.g. `summarize`) independently of any user. |
| **Global killswitch** | A deployment-wide spend cap across all users and actions (sharded for throughput; enforced approximately). |
| **One-time bumps** | "Approve another $X" at any level (user / action / global) without changing the standing cap — daily bumps are today-only, lifetime bumps permanent. |
| **Model policy** | Allow/deny lists for models; an unknown/unpriced model **fails closed** (charged a conservative max, never $0). |
| **Replay** | Re-run any stored request with edited messages or a different model; re-runs are linked to their original (lineage). |
| **Agent-ready** | `ai.languageModel(ctx, { userId })` is a standard AI SDK model — drop it into [`@convex-dev/agent`](https://www.npmjs.com/package/@convex-dev/agent) and every agent generation is budgeted. |
| **Built-in dashboard** | `ai.registerRoutes(http)` mounts a self-contained admin dashboard (buckets, requests, usage charts, settings) at a URL — one line, no UI to build. |

---

## Install

Requires `convex@^1.45`, AI SDK 5+, and a Convex team on a paid plan (the
gateway is a paid feature). Runs in Convex's **default runtime** — no
`"use node"` required (the component is pure V8 mutations/queries/crons, and
`ai.chat` / `ai.languageModel` are `fetch`-based).

```sh
npm install @convex-dev/ai-budget @convex-dev/ai-sdk-provider ai
```

Register the component:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import aiBudget from "@convex-dev/ai-budget/convex.config";

const app = defineApp();
app.use(aiBudget);
export default app;
```

Create a client:

```ts
// convex/ai.ts
import { AIBudget } from "@convex-dev/ai-budget";
import { components } from "./_generated/api";

export const ai = new AIBudget(components.aiBudget, {
  defaultModel: "openai/gpt-4o-mini",
  // Optional: surface soft-limit warnings even on the Agent/languageModel path.
  onSoftLimit: ({ userId, warnings }) => console.warn(userId, warnings),
});
```

The admin API is namespaced: `ai.users.*`, `ai.actions.*`, `ai.global.*`,
`ai.models.*`, `ai.prices.*`, and `ai.requests.*`; `ai.chat` and
`ai.languageModel` are top-level.

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

Pass an explicit `{ userId }` only for service/admin flows or when you manage
identity yourself.

Give someone a budget:

```ts
await ai.users.setLimits(ctx, {
  userId: "alice",
  dailySpendLimitNanos: 1_000_000_000, // $1.00 / day (1e9 nano)
  dailyTokenLimit: 500_000,
  requestsPerMinute: 20,
});
```

When a request would exceed a **hard** cap, `chat` throws a `ConvexError`
carrying `{ kind: "AIBudgetLimit", code, reason }`; the attempt is still
recorded (`status: "blocked"`) so you can see who's hitting limits.

---

## API reference

All methods are called from a Convex **action** (they run the gateway call) or,
for the read-only ones, a query. `ctx` is the Convex context.

**Money is integer nanodollars** (`1 USD = 1e9 nano`) everywhere — costs, limits,
and prices. Integers avoid the rounding drift floating-point cents accumulate and
keep cap comparisons exact (exact to ~$9M per value). `$1 = 1_000_000_000`.

### Generating

```ts
ai.chat(ctx, {
  userId?,           // defaults to the authenticated caller (ctx.auth)
  prompt?,           // or:
  messages?,         // [{ role, content }]
  model?,            // defaults to defaultModel
  action?,           // attribution name; defaults to the calling Convex action
  tags?,             // extra dimensions: [{ dimension: "customer", value: "acme" }, …]
}): Promise<{ text, requestId, costNanos, promptTokens, completionTokens, warnings }>
```

`warnings` is non-empty only when a **soft** limit was exceeded. If no `userId`
is passed and there is no authenticated user, `chat` throws — budgets are never
silently un-attributed.

### As an AI SDK model (Agent, generateText, streamText)

```ts
ai.languageModel(ctx, { userId, model?, action? }): LanguageModel
```

Returns a standard AI SDK `LanguageModel` that enforces the user's budget and
records usage/cost on every call — including streaming. Use it anywhere an AI
SDK model is expected:

```ts
import { Agent } from "@convex-dev/agent";

// Construct per-request so the agent is bound to this user.
const agent = new Agent(components.agent, {
  name: "assistant",
  languageModel: ai.languageModel(ctx, { userId }),
});
const { threadId } = await agent.createThread(ctx, { userId });
const result = await agent.generateText(ctx, { threadId }, { prompt });
```

Every generation the agent makes is now tracked and budgeted, attributed to
`userId` and to the calling action. See `example/convex/agentDemo.ts`.

### Replay

```ts
ai.requests.rerun(ctx, { requestId, messages?, model? }): Promise<ChatResult>
ai.requests.lineage(ctx, { requestId }): Promise<{ ancestors, reruns }>
```

`rerun` re-runs a stored request (optionally with edited messages/model), linked
to the original. `lineage` walks the re-run chain in both directions.

### User limits

```ts
ai.users.setLimits(ctx, {
  userId,
  requestsPerMinute?,
  maxConcurrent?,            // max in-flight requests at once
  dailySpendLimitNanos?,
  monthlySpendLimitNanos?,   // calendar-month budget (UTC)
  lifetimeSpendLimitNanos?,
  dailyTokenLimit?,
  monthlyTokenLimit?,
  lifetimeTokenLimit?,
  warnAtPct?,                // e.g. 0.8 → fire onThreshold at 80% of a cap
  enforcement?,             // "hard" (block, default) | "soft" (warn but allow)
  blocked?,                 // hard block on/off
})
ai.users.delete(ctx, { userId })   // remove a user and all their request rows
```

The same limit fields apply to `ai.actions.setLimits` and `ai.tag(d).setLimits`.
Pass a field as `undefined` to clear that limit (unlimited).

### Per-action budgets

Spend is attributed to the calling action automatically. Cap a feature:

```ts
ai.actions.setLimits(ctx, {
  name,                          // e.g. "ai:summarize"
  dailySpendLimitNanos?,
  lifetimeSpendLimitNanos?,
  dailyTokenLimit?,
  lifetimeTokenLimit?,
  enforcement?,                  // "hard" | "soft"
  blocked?,                      // kill switch for the whole feature
})
```

### Tagged budgets (custom dimensions)

`user` and `action` are the two built-in *dimensions*. To classify or budget
along any other axis — team, project, tenant, customer, environment, feature —
attach `tags` to a call and cap a value with `ai.tag(dimension)`:

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
await ai.tag("customer").bump(ctx, { value: "acme", dailyNanos: 10 * 1_000_000_000 });
await ai.tag("customer").list(ctx);                 // every customer's spend & caps
await ai.tag("customer").get(ctx, { value: "acme" }); // one bucket
```

A single request is admitted only if it fits **every** bucket it touches (user,
action, and each tag) — the same exact reserve-then-settle check runs per bucket.
Uncapped buckets never serialize, so adding tags you don't cap is free at
admission; their running totals still accrue for reporting. `ai.users.*` and
`ai.actions.*` are simply sugar over `ai.tag("user")` / `ai.tag("action")`.

Every dimension namespace (`users`, `actions`, `tag(d)`) shares the same methods:
`list`, `get`, `setLimits`, `bump`, `adjust`, `history`, `adjustments`, `delete`.

### Spend history (survives retention)

Request rows are retained only briefly (see retention), but **durable per-bucket
day/month rollups are not** — so charts and "what did we spend last month" keep
working:

```ts
await ai.users.history(ctx, { userId, period: "month" });  // [{ stamp, spendNanos, tokens, requests }]
await ai.tag("customer").history(ctx, { value: "acme", period: "day", limit: 30 });
```

### Approaching-limit alerts

Set a threshold (per bucket via `warnAtPct`, or a deployment default) and get a
callback before a cap is hit — plus one when a hard cap blocks:

```ts
await ai.global.setAlertDefaults(ctx, { warnAtPct: 0.8 });   // 80%, all buckets
await ai.users.setLimits(ctx, { userId, warnAtPct: 0.9 });   // override per bucket

new AIBudget(components.aiBudget, {
  onThreshold:    ({ userId, messages }) => notify(userId, messages),  // approaching
  onLimitReached: ({ userId, reason })   => notify(userId, reason),    // blocked
  onSoftLimit:    ({ userId, messages }) => notify(userId, messages),  // soft-cap exceeded
});
```

`chat()` also returns `notices` (approaching) alongside `warnings` (soft-exceeded).

### Manual credits & debits

Comp a user or correct an overcharge. Negative = credit, positive = extra charge;
it adjusts the live day/month/lifetime windows, the history, and an audit log:

```ts
await ai.users.adjust(ctx, { userId, deltaNanos: -5 * 1_000_000_000, reason: "goodwill" });
await ai.users.adjustments(ctx, { userId });   // the audit log
```

### Global (deployment-wide) budget

```ts
ai.global.setLimits(ctx, { dailySpendLimitNanos?, lifetimeSpendLimitNanos?, enforcement? })
ai.global.status(ctx)   // { limits, spentTodayNanos, spentTotalNanos }
```

A killswitch across all users and actions. Backed by a sharded counter for
throughput, so it's enforced **approximately** (bounded overshoot under burst) —
per-user and per-action caps remain exact.

### One-time bumps ("approve another $X")

```ts
ai.users.bump(ctx, { userId, dailyNanos?, lifetimeNanos? })
ai.actions.bump(ctx, { name, dailyNanos?, lifetimeNanos? })
ai.global.bump(ctx, { dailyNanos?, lifetimeNanos? })
```

Adds headroom on top of the standing cap without changing it. Daily bumps apply
to today only (reset with the day); lifetime bumps are permanent.

### Model policy

```ts
ai.models.setPolicy(ctx, { mode, models })
// mode: "open" (default) | "allowlist" (only these) | "denylist" (all but these)
ai.models.getPolicy(ctx)
```

### Pricing

Prices are in **nanodollars per million tokens**. Sensible defaults ship for
common models (validated against OpenRouter's public pricing); override or add
any model:

```ts
ai.prices.set(ctx, { model, inputNanosPerMTok, outputNanosPerMTok, cachedNanosPerMTok? })  // ≥ 0
ai.prices.list(ctx)
```

**Cached tokens & actual cost.** The gateway reports a real cached-token count
(`usage.inputTokenDetails.cacheReadTokens`), so the cached slice of a prompt is
billed at `cachedNanosPerMTok` (or a default 10%-of-input discount) instead of
the full input rate. The gateway does **not** currently return a dollar cost, so
cost is computed from tokens — but `finishRequest` accepts an authoritative
`costNanos` and prefers it whenever present, so adopting a real gateway cost is a
one-line change the day it's available.

**Real prices from an API.** The gateway's `provider/model` ids match
OpenRouter's, whose public models endpoint returns per-token pricing — so you can
keep prices current from your own action (this is app code; the component just
stores what you give it):

```ts
const { data } = await (await fetch("https://openrouter.ai/api/v1/models")).json();
const p = data.find((m) => m.id === "openai/gpt-4o-mini").pricing;
await ai.prices.set(ctx, {
  model: "openai/gpt-4o-mini",
  inputNanosPerMTok: Math.round(Number(p.prompt) * 1e15),   // $/token → nano/Mtok
  outputNanosPerMTok: Math.round(Number(p.completion) * 1e15),
});
```

See `example/convex/ai.ts` → `syncPrices` for a full sync over several models.

An unpriced model is charged the conservative maximum of the known table (so a
cap can never be bypassed by naming an unlisted model) and its request rows are
flagged `unpricedModel: true` so you know to add a real price.

### Observability

```ts
ai.users.list(ctx)                      // per-user spend today / month / total / limits
ai.actions.list(ctx)                    // per-action spend & totals
ai.tag("customer").list(ctx)            // spend & caps for any custom dimension
ai.users.history(ctx, { userId, period: "month" })   // durable spend-over-time
ai.requests.list(ctx, { userId?, limit? })           // the audit log (blocked included)
ai.requests.list(ctx, { dimension: "customer", value: "acme" })  // filter the log by any tag
```

### Built-in admin dashboard

The component ships a self-contained admin dashboard — buckets & limits, the
request log, spend-over-time charts, and global settings. Mount it on your HTTP
router with **one call** (no UI to build, no extra queries to write):

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

It then lives at `https://<deployment>.convex.site/aibudget` (override with
`path`). **It is a public internet endpoint, so you must gate it**: pass
`authorize` (return `true` to allow), or set the `AI_BUDGET_DASHBOARD_TOKEN` env
var (sent as `Authorization: Bearer …` or `?token=`). With neither, every route
returns 401. Everything the page shows is backed by the component's own
functions, so there is nothing else to wire up.

---

## How spend caps stay correct

A naive tracker checks the running total, makes the call, then records the cost.
Under concurrency that leaks badly: dozens of in-flight requests all read the
same pre-spend total and all pass, so spend blows past the cap (measured at
~40× before this design).

`ai-budget` instead **reserves then settles**:

1. **Reserve.** `startRequest` estimates the request's cost/tokens and, *in the
   same transaction as the limit check*, reserves them against the capped
   entity. Under Convex's serializable isolation this makes admission a true
   atomic check-and-reserve — concurrent requests see each other's holds.
2. **Settle.** `finishRequest` writes only the request's own (uncontended) row
   and schedules a fold of the real cost into the totals, releasing the
   reservation. A request is therefore never orphaned mid-flight.
3. **Reconcile.** A once-a-minute cron folds any stragglers and releases
   reservations for requests that died before settling. Settlement is
   **exactly-once** (a terminal request is never re-folded), so a slow request
   that the reconciler already swept can't double-count when it finally returns.

Reservations are only taken on buckets that actually have a cap, so uncapped
traffic never serializes — this is what makes arbitrary `tags` cheap: a request
reserves on one row per *capped* dimension it carries, and nothing else. The
`error.md` file documents the adversarial audits this design survived, with live
repros.

**One guarantee, all scopes.** Every per-bucket cap — user, action, or any
custom tag dimension — and the global cap run through the *same* admission check:
a request is admitted only when `committed + reserved + estimate ≤ cap` (bumps
included) for **every** bucket it touches. The only thing that differs is the
holder: each per-bucket cap reserves on a single document, an exact atomic
check-and-reserve; the **global** killswitch is backed by a sharded
counter for throughput, so its committed total is read as an eventually-consistent
sum with no cross-request reservation. That makes the global cap **approximate** —
it can overshoot by a bounded amount under a burst — the deliberate
exactness-for-throughput trade for a deployment-wide cap, and the only scope
that isn't exact.

---

## Security: before you ship

The component is deliberately **identity-agnostic** — like
`@convex-dev/rate-limiter`, it trusts the `userId` and admin calls your app
hands it. **Your app owns auth.** The `example/` app skips auth on purpose to
keep the demo frictionless (a persona dropdown, public admin functions); do not
copy its endpoints verbatim. In production:

1. **Let `userId` default to the authenticated caller** (that's the built-in
   behavior — `ai.chat(ctx, { prompt })` uses `ctx.auth.getUserIdentity()`).
   Only pass an explicit `userId` from a trusted server context; never forward a
   client-supplied id, or a caller can spend under someone else's budget or
   dodge their own limits by rotating ids.
2. **Gate every admin call** — `setLimits`, `setActionLimits`, `setModelPolicy`,
   `setPrice`, `deleteUser` — behind an admin check. A limit-management surface
   must not be operable by the party being limited.
3. **Scope reads and replay to the owner.** `listRequests` / `getRequest` /
   `lineage` return full prompts, responses, and spend, and `rerun` re-runs a
   request billed to its **original** user. An unchecked client `requestId` is an
   IDOR — verify `request.userId === caller`, or treat `rerun` and the
   cross-user views as admin-only.

---

## Example app

`example/` is a full working demo: chat as different personas on the left; a live
admin panel on the right with the request audit log (inspect → edit → re-run,
with lineage), a users table (rate / spend / token limits, soft toggle, block,
one-time bump), and per-action budgets.

Per-user limits — rate, daily spend, daily tokens, hard/soft, block, one-time bump:

![Users & Limits admin table](docs/users.png)

Per-action budgets, auto-attributed to the calling Convex function (including
agent generations via `agentChat`):

![Actions & Budgets admin table](docs/actions.png)

```sh
cd example
npm install
npx convex dev      # terminal 1 — provisions a dev deployment
npm run dev         # terminal 2 — Vite app
```

### What's in the component vs. the demo

The component (`src/`) is **only** the metering/budget primitive — it knows
nothing about chat or evaluation. Everything below lives in `example/` as
**application code that uses the component**, not as part of the published API:

- The real features being metered — `sendMessage`, `summarize`, the agent (`agentDemo.ts`).
- An **eval playground** — a 🧪 Experiment tab with three modes:
  - **Matrix** — run one prompt across a system-prompt × model grid; an LLM judge
    ranks them by *your* criteria.
  - **Backtest** — replay a candidate system prompt against a specific action's
    real historical requests and judge whether it improved each one.
  - **Evolve** — an LLM iteratively improves a prompt toward a goal, scored on
    real traffic, **stopping when it hits a spend budget.**
- The public endpoints and UI wiring that drive the admin panel.

These are built entirely on two component primitives: `ai.chat(...)` (every eval
call is budgeted and tracked) and `ai.requests.list(...)` (the audit log *is* the
eval dataset). They're a **"how to build on it" reference, not the component's
surface** — a real, non-trivial feature (budget-capped prompt backtesting on live
traffic) that falls out of the primitives without the component needing to know
eval exists. If you productize this, it belongs in your app or its own component
that *composes* `@convex-dev/ai-budget` — never folded back into it.

---

## Development

```sh
npm test            # vitest + convex-test: reserve/settle, exactly-once,
                    # token quotas, soft limits, model policy, pricing
npm run build       # emit dist/ (client + component) for publishing
```

## Layout

- `src/component/` — **the component** (published): tables (`users`, `actions`,
  `requests`, `prices`, `settings`), the reserve/settle mutations (`startRequest` /
  `finishRequest`), the idempotent `foldTotals`, the `reconcile` cron, and the
  admin functions. Mounts `@convex-dev/sharded-counter` for the global total.
- `src/client/` — **the client** (published): the `AIBudget` class — `chat`,
  `languageModel` (AI SDK middleware around `convexGateway`), and the namespaced
  admin API (`ai.users.*`, `ai.actions.*`, `ai.global.*`, `ai.models.*`,
  `ai.prices.*`, `ai.requests.*`).
- `example/` — **the demo app** (not published): real features, the eval
  playground, and the UI, all built on the two files above.

## License

Apache-2.0
