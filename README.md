# ☂️ @convex-dev/ai-budget

**Add this component and get worry-free AI.** A metered, budget-governed layer
over the [Convex AI Gateway](https://docs.convex.dev/ai-gateway/overview). Point
your LLM calls through it and every request is tracked, priced, attributed, and
held to a budget — with spend caps that actually hold under concurrent load.

```ts
const { text, costCents } = await ai.chat(ctx, { userId, prompt });
```

That one call is authenticated to the gateway with a short-lived deployment
token (no API keys to manage), checked against the user's limits, billed to the
right user and feature, and written to a full audit log you can replay later.

---

## What you get

| | |
|---|---|
| **Usage & cost tracking** | Every request stored with messages, response, tokens, latency, and per-request cost. |
| **Attribution** | Each call is attributed to a `userId` **and** to the Convex action that made it — auto-detected via `ctx.meta`, no manual tagging. Running totals per user and per action. |
| **Spend & token limits** | Per-user daily / lifetime **spend** and **token** budgets, plus a requests-per-minute rate limit and a block switch. |
| **Concurrency-safe caps** | A reserve-then-settle design makes admission a true atomic check — concurrent in-flight requests can't blow past the cap (a naive implementation overshoots ~40×). |
| **Hard or soft** | Each limit either **blocks** (`hard`) or **allows-with-a-warning** (`soft`). |
| **Per-feature budgets** | Cap or disable a whole action (e.g. `summarize`) independently of any user. |
| **Model policy** | Allow/deny lists for models; an unknown/unpriced model **fails closed** (charged a conservative max, never $0). |
| **Replay** | Re-run any stored request with edited messages or a different model; re-runs are linked to their original (lineage). |
| **Agent-ready** | `ai.languageModel(ctx, { userId })` is a standard AI SDK model — drop it into [`@convex-dev/agent`](https://www.npmjs.com/package/@convex-dev/agent) and every agent generation is budgeted. |

---

## Install

Requires `convex@^1.45`, AI SDK 5+, and a Convex team on a paid plan (the
gateway is a paid feature).

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
import { WorryFreeAI } from "@convex-dev/ai-budget";
import { components } from "./_generated/api";

export const ai = new WorryFreeAI(components.aiBudget, {
  defaultModel: "openai/gpt-4o-mini",
});
```

---

## Quickstart

```ts
// convex/ai.ts
import { v } from "convex/values";
import { action } from "./_generated/server";

export const sendMessage = action({
  args: { userId: v.string(), prompt: v.string() },
  handler: async (ctx, { userId, prompt }) => {
    // Limit-checked, tracked, priced. Throws a ConvexError if over a hard cap.
    const { text, costCents, warnings } = await ai.chat(ctx, { userId, prompt });
    return { text, costCents, warnings };
  },
});
```

Give someone a budget:

```ts
await ai.setLimits(ctx, {
  userId: "alice",
  dailySpendLimitCents: 100,     // $1.00 / day
  dailyTokenLimit: 500_000,
  requestsPerMinute: 20,
});
```

When a request would exceed a **hard** cap, `chat` throws a `ConvexError`
carrying `{ kind: "AIGatewayLimit", code, reason }`; the attempt is still
recorded (`status: "blocked"`) so you can see who's hitting limits.

---

## API reference

All methods are called from a Convex **action** (they run the gateway call) or,
for the read-only ones, a query. `ctx` is the Convex context.

### Generating

```ts
ai.chat(ctx, {
  userId,
  prompt?,           // or:
  messages?,         // [{ role, content }]
  model?,            // defaults to defaultModel
  action?,           // attribution name; defaults to the calling Convex action
}): Promise<{ text, requestId, costCents, promptTokens, completionTokens, warnings }>
```

`warnings` is non-empty only when a **soft** limit was exceeded.

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
ai.rerun(ctx, { requestId, messages?, model? }): Promise<ChatResult>
ai.lineage(ctx, { requestId }): Promise<{ ancestors, reruns }>
```

`rerun` re-runs a stored request (optionally with edited messages/model), linked
to the original. `lineage` walks the re-run chain in both directions.

### User limits

```ts
ai.setLimits(ctx, {
  userId,
  requestsPerMinute?,
  dailySpendLimitCents?,
  lifetimeSpendLimitCents?,
  dailyTokenLimit?,
  lifetimeTokenLimit?,
  enforcement?,       // "hard" (block, default) | "soft" (warn but allow)
  blocked?,           // hard block on/off
})
ai.deleteUser(ctx, { userId })   // remove a user and all their request rows
```

Pass a field as `undefined` to clear that limit (unlimited).

### Per-action budgets

Spend is attributed to the calling action automatically. Cap a feature:

```ts
ai.setActionLimits(ctx, {
  name,                          // e.g. "ai:summarize"
  dailySpendLimitCents?,
  lifetimeSpendLimitCents?,
  dailyTokenLimit?,
  lifetimeTokenLimit?,
  enforcement?,                  // "hard" | "soft"
  disabled?,                     // kill switch for the whole feature
})
```

### Model policy

```ts
ai.setModelPolicy(ctx, { mode, models })
// mode: "open" (default) | "allowlist" (only these) | "denylist" (all but these)
ai.getModelPolicy(ctx)
```

### Pricing

Prices are in **cents per million tokens**. Sensible defaults ship for common
models; override or add any model:

```ts
ai.setPrice(ctx, { model, inputCentsPerMTok, outputCentsPerMTok })  // must be ≥ 0
ai.listPrices(ctx)
```

An unpriced model is charged the conservative maximum of the known table (so a
cap can never be bypassed by naming an unlisted model) and its request rows are
flagged `unpricedModel: true` so you know to add a real price.

### Observability

```ts
ai.listUsers(ctx)                      // per-user spend today / total / tokens / limits
ai.listActions(ctx)                    // per-action spend & totals
ai.listRequests(ctx, { userId?, limit? })  // the audit log (blocked attempts included)
```

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

Reservations are only taken on entities that actually have a cap, so uncapped
traffic never serializes. The `error.md` file documents the adversarial audits
this design survived, with live repros.

---

## Security: before you ship

The component is deliberately **identity-agnostic** — like
`@convex-dev/rate-limiter`, it trusts the `userId` and admin calls your app
hands it. **Your app owns auth.** The `example/` app skips auth on purpose to
keep the demo frictionless (a persona dropdown, public admin functions); do not
copy its endpoints verbatim. In production:

1. **Derive `userId` on the server**, never from a client argument — otherwise a
   caller can spend under someone else's budget or dodge their own limits by
   rotating ids.
   ```ts
   const who = await ctx.auth.getUserIdentity();
   if (!who) throw new Error("Unauthenticated");
   await ai.chat(ctx, { userId: who.subject, prompt });
   ```
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
with lineage), a users table (rate / spend / token limits, soft toggle, block),
and per-action budgets.

```sh
cd example
npm install
npx convex dev      # terminal 1 — provisions a dev deployment
npm run dev         # terminal 2 — Vite app
```

---

## Development

```sh
npm test            # vitest + convex-test: reserve/settle, exactly-once,
                    # token quotas, soft limits, model policy, pricing
npm run build       # emit dist/ (client + component) for publishing
```

## Layout

- `src/component/` — the component: tables (`users`, `actions`, `requests`,
  `prices`, `settings`), the reserve/settle mutations (`startRequest` /
  `finishRequest`), the idempotent `foldTotals`, and the `reconcile` cron.
- `src/client/` — the `WorryFreeAI` class: `chat`, `languageModel` (AI SDK
  middleware around `convexGateway`), `rerun`, and the admin methods above.
- `example/` — the demo app.

## License

Apache-2.0
