# ☂️ @convex-dev/ai-budget

**Add this component and get worry-free AI.** A metered, budget-governed layer
over the [Convex AI Gateway](https://docs.convex.dev/ai-gateway/overview): every
LLM call is automatically:

- **Tracked** — full request/response, tokens, latency, per-request cost
- **Priced** — per-model prices (sensible defaults, admin-overridable)
- **Attributed** — every call belongs to a user *and* to the Convex action that
  made it (auto-detected via `ctx.meta`, no manual tagging), with running totals
- **Limited** — per-user rate limits, daily & lifetime spend limits, block
  switch; plus per-action budgets (cap or disable a whole feature)
- **Replayable** — admins can re-run any stored inference with edited messages or a different model

No API keys to manage — the gateway authenticates with a short-lived deployment token.

## Install

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import aiBudget from "@convex-dev/ai-budget/convex.config";

const app = defineApp();
app.use(aiBudget);
export default app;
```

## Use

```ts
// convex/ai.ts
import { WorryFreeAI } from "@convex-dev/ai-budget";
import { components } from "./_generated/api";

const ai = new WorryFreeAI(components.aiBudget, {
  defaultModel: "openai/gpt-4o-mini",
});

export const sendMessage = action({
  args: { userId: v.string(), prompt: v.string() },
  handler: async (ctx, { userId, prompt }) => {
    // Limit-checked, tracked, priced. Throws ConvexError if over limit.
    const { text, costCents } = await ai.chat(ctx, { userId, prompt });
    return { text, costCents };
  },
});
```

### With the Agent component (or any AI SDK code)

`ai.languageModel()` returns a standard AI SDK `LanguageModel` that enforces
limits and records usage on every `generateText` / `streamText` call:

```ts
const agent = new Agent(components.agent, {
  languageModel: ai.languageModel(ctx, { userId }),
});
```

### Limits & admin

```ts
await ai.setLimits(ctx, { userId: "mallory", requestsPerMinute: 5, dailySpendLimitCents: 100 });
// Per-feature budgets, keyed by the calling action's name:
await ai.setActionLimits(ctx, { name: "ai:summarize", dailySpendLimitCents: 500 });
await ai.listActions(ctx);          // spend & totals per action name
await ai.listUsers(ctx);            // spend today, total spend, tokens, limits
await ai.listRequests(ctx, {});     // full audit log
await ai.rerun(ctx, { requestId, messages: editedMessages }); // replay with edits
await ai.setPrice(ctx, { model: "openai/gpt-4o-mini", inputCentsPerMTok: 15, outputCentsPerMTok: 60 });
```

Blocked attempts are recorded too (`status: "blocked"`), so you can see who's
hitting limits.

## Example app

`example/` is a full demo: chat as different personas on the left; a live admin
panel on the right with the request audit log (inspect → edit messages → re-run)
and a users table with editable rate/spend limits.

```sh
cd example
npm install
npx convex dev          # terminal 1
npm run dev             # terminal 2
```

## How it works

- `src/component/` — isolated tables (`requests`, `users`, `prices`) and the
  limit-enforcing `startRequest` / cost-recording `finishRequest` mutations.
  All writes are transactional; blocked attempts are recorded, not lost.
- `src/client/` — the `WorryFreeAI` class apps use: `chat`, `languageModel`
  (AI SDK middleware wrapper around `convexGateway`), `rerun`, and admin
  passthroughs.

### Spend caps are concurrency-safe (reserve → settle)

A naive "check the total, then record cost after the call" leaks badly: dozens of
concurrent requests all read the same pre-spend total and all pass, blowing past
the cap (measured at 40x). This component instead **reserves** each request's
estimated cost against the capped entity *in the same transaction as the limit
check* — so admission is atomic under Convex's serializable isolation — then
**settles** the reservation to the actual cost when the request finishes.
`finishRequest` writes only the request's own row and schedules the totals fold,
so a request is never orphaned mid-flight; a once-a-minute `reconcile` cron folds
any stragglers and releases reservations for requests that died before settling.
Reservations are only taken on entities that have a cap, so uncapped traffic
never serializes. See `error.md` for the adversarial audit and live repros.
