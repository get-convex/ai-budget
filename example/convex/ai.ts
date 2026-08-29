// ⚠️ DEMO ONLY — no authentication. `userId` is taken from the client and the
// admin mutations (setLimits/setActionLimits/setModelPolicy/deleteUser) and the
// history queries are public. That's fine for a local demo, NOT for production.
// See the "Security: before you ship this" section of the README for the
// server-derived-identity + admin-gate + scoped-query pattern.
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { AIBudget } from "../../src/client";

const ai = new AIBudget(components.aiBudget, {
  defaultModel: "openai/gpt-4o-mini",
});

const SYSTEM_PROMPT = "You are a concise, friendly assistant. Keep replies short.";

export const sendMessage = action({
  args: {
    userId: v.string(),
    prompt: v.string(),
    // prior turns (excluding the system message, which is prepended here)
    history: v.optional(
      v.array(v.object({ role: v.string(), content: v.string() }))
    ),
    model: v.optional(v.string()),
  },
  handler: async (ctx, { userId, prompt, history, model }) => {
    // Send the full chain — system + conversation history + new turn — so the
    // stored request holds it all (inspect/edit any message, then re-run).
    return await ai.chat(ctx, {
      userId,
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...(history ?? []),
        { role: "user", content: prompt },
      ],
    });
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

// Run one prompt across a matrix of system-prompt variants × models. Every run
// is a tracked request (attributed to "ai:experiment"), so cost/tokens are
// captured per variant for side-by-side comparison and A/B testing.
export const experiment = action({
  args: {
    userId: v.string(),
    prompt: v.string(),
    systems: v.optional(v.array(v.string())),
    models: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { userId, prompt, systems, models }) => {
    const sys = systems?.length ? systems : [SYSTEM_PROMPT];
    const mods = models?.length ? models : ["openai/gpt-4o-mini"];
    const combos = sys.flatMap((system) => mods.map((model) => ({ system, model })));
    return await Promise.all(
      combos.map(async ({ system, model }) => {
        try {
          const r = await ai.chat(ctx, {
            userId,
            model,
            action: "ai:experiment",
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
          });
          return {
            system,
            model,
            requestId: r.requestId,
            text: r.text,
            costNanos: r.costNanos,
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            cachedTokens: r.cachedTokens,
            error: null as string | null,
          };
        } catch (e: any) {
          return {
            system,
            model,
            error: String(e?.data?.reason ?? e?.message ?? e),
          };
        }
      })
    );
  },
});

// Have a judge model rank candidate outputs for a prompt and pick the best.
export const judge = action({
  args: {
    prompt: v.string(),
    candidates: v.array(v.object({ label: v.string(), text: v.string() })),
    criteria: v.optional(v.string()),
    model: v.optional(v.string()),
  },
  handler: async (ctx, { prompt, candidates, criteria, model }) => {
    const rubric = criteria?.trim() || "overall quality and helpfulness";
    const list = candidates
      .map((c) => `### Candidate ${c.label}\n${c.text}`)
      .join("\n\n");
    const res = await ai.chat(ctx, {
      userId: "judge",
      model: model ?? "openai/gpt-4o",
      action: "ai:judge",
      messages: [
        {
          role: "system",
          content:
            `You are an impartial evaluator. Rank the candidate responses by how well they meet these criteria: "${rubric}". Respond ONLY as JSON: {"winner":"<label>","rationale":"<one sentence>","ranking":["<label>", ...]}.`,
        },
        {
          role: "user",
          content: `User prompt:\n${prompt}\n\nCandidates:\n${list}\n\nReturn only the JSON.`,
        },
      ],
    });
    let parsed: any;
    try {
      parsed = JSON.parse(res.text.match(/\{[\s\S]*\}/)?.[0] ?? res.text);
    } catch {
      parsed = { winner: null, rationale: res.text, ranking: [] };
    }
    return { ...parsed, costNanos: res.costNanos };
  },
});

// Backtest a system-prompt (and/or model) change against REAL historical chat
// requests: replay each with the new prompt, then judge new-vs-original. The
// audit log becomes an eval set; the whole run is budget-capped like any other.
export const backtest = action({
  args: {
    // which action's real traffic to backtest (its prompt is what you're tuning)
    action: v.string(),
    newSystem: v.string(),
    criteria: v.optional(v.string()),
    model: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { action: targetAction, newSystem, criteria, model, limit }) => {
    const rubric = criteria?.trim() || "overall quality and helpfulness";
    const N = Math.min(limit ?? 5, 10);
    const all = await ai.requests.list(ctx, { limit: 200 });
    const sample = all
      .filter(
        (r: any) =>
          r.status === "success" &&
          r.actionName === targetAction &&
          r.responseText &&
          r.messages?.some((m: any) => m.role === "user")
      )
      .slice(0, N);

    const results = await Promise.all(
      sample.map(async (r: any) => {
        const convo = r.messages.filter((m: any) => m.role !== "system");
        try {
          const rr = await ai.chat(ctx, {
            userId: r.userId,
            model: model ?? r.model,
            action: "ai:backtest",
            messages: [{ role: "system", content: newSystem }, ...convo],
          });
          const j = await ai.chat(ctx, {
            userId: "judge",
            model: "openai/gpt-4o",
            action: "ai:judge",
            messages: [
              {
                role: "system",
                content:
                  `Two assistant responses answer the same user request. Which better meets these criteria: "${rubric}"? Respond ONLY JSON: {"better":"original"|"new"|"tie","why":"<short>"}.`,
              },
              {
                role: "user",
                content: `Request:\n${convo.map((m: any) => `${m.role}: ${m.content}`).join("\n")}\n\nORIGINAL:\n${r.responseText}\n\nNEW:\n${rr.text}`,
              },
            ],
          });
          let v2: any;
          try {
            v2 = JSON.parse(j.text.match(/\{[\s\S]*\}/)?.[0] ?? j.text);
          } catch {
            v2 = { better: "tie", why: j.text };
          }
          return {
            prompt: convo.map((m: any) => m.content).join(" / "),
            original: r.responseText,
            updated: rr.text,
            better: v2.better,
            why: v2.why,
            costNanos: (rr.costNanos ?? 0) + (j.costNanos ?? 0),
          };
        } catch (e: any) {
          return {
            prompt: convo.map((m: any) => m.content).join(" / "),
            error: String(e?.data?.reason ?? e?.message ?? e),
          };
        }
      })
    );
    return {
      results,
      total: results.length,
      improved: results.filter((r) => r.better === "new").length,
      regressed: results.filter((r) => r.better === "original").length,
    };
  },
});

// Evolve a system prompt toward a goal, bounded by a budget. Each round scores
// the current prompt on real requests (judge rates goal-fit 0-10), then an LLM
// proposes an improvement. The loop stops at `rounds` OR when the component's
// tracked spend for the run reaches `budgetNanos` — the budget is the safe,
// natural stopping condition for an otherwise-unbounded optimization loop.
export const evolve = action({
  args: {
    action: v.string(),
    goal: v.string(),
    criteria: v.optional(v.string()),
    seedSystem: v.string(),
    rounds: v.optional(v.number()),
    sampleSize: v.optional(v.number()),
    budgetNanos: v.optional(v.number()),
  },
  handler: async (ctx, { action: targetAction, goal, criteria, seedSystem, rounds, sampleSize, budgetNanos }) => {
    const rubric = criteria?.trim() || goal;
    const maxRounds = Math.min(rounds ?? 4, 8);
    const N = Math.min(sampleSize ?? 3, 5);
    const budget = budgetNanos ?? Infinity;

    const all = await ai.requests.list(ctx, { limit: 200 });
    const sample = all
      .filter(
        (r: any) =>
          r.status === "success" &&
          r.actionName === targetAction &&
          r.messages?.some((m: any) => m.role === "user")
      )
      .slice(0, N)
      .map((r: any) => ({
        userId: r.userId,
        model: r.model,
        convo: r.messages.filter((m: any) => m.role !== "system"),
      }));
    if (!sample.length)
      return { error: "No real chat requests to evolve against. Chat first." };

    let spent = 0;
    const chat = async (args: any) => {
      const r = await ai.chat(ctx, { action: "ai:evolve", ...args });
      spent += r.costNanos ?? 0;
      return r;
    };
    const scoreSystem = async (system: string) => {
      let total = 0;
      const outs: string[] = [];
      for (const s of sample) {
        const gen = await chat({
          userId: s.userId,
          model: s.model,
          messages: [{ role: "system", content: system }, ...s.convo],
        });
        outs.push(gen.text);
        const jr = await chat({
          userId: "evolve-judge",
          model: "openai/gpt-4o-mini",
          messages: [
            { role: "system", content: `Rate 0-10 how well the response meets these criteria: "${rubric}". Respond ONLY JSON {"score":<number>}.` },
            { role: "user", content: `User: ${s.convo.map((m: any) => m.content).join(" ")}\n\nResponse: ${gen.text}` },
          ],
        });
        let sc = 0;
        try { sc = Number(JSON.parse(jr.text.match(/\{[\s\S]*\}/)?.[0] ?? "{}").score) || 0; } catch {}
        total += sc;
      }
      return { avg: total / sample.length, outs };
    };

    const history: any[] = [];
    let current = seedSystem;
    let best = { system: seedSystem, score: -1 };
    let stopped: "rounds" | "budget" = "rounds";

    try {
      for (let round = 0; round < maxRounds; round++) {
        if (spent >= budget) { stopped = "budget"; break; }
        const { avg, outs } = await scoreSystem(current);
        history.push({ round: round + 1, system: current, score: avg, spentNanos: spent });
        if (avg > best.score) best = { system: current, score: avg };
        if (spent >= budget) { stopped = "budget"; break; }
        const prop = await chat({
          userId: "evolve",
          model: "openai/gpt-4o",
          messages: [
            { role: "system", content: `You refine system prompts toward a goal: "${goal}". Given the current prompt (scored ${avg.toFixed(1)}/10) and sample outputs, propose a better system prompt. Respond ONLY JSON {"system":"<new prompt>"}.` },
            { role: "user", content: `Current system prompt:\n${current}\n\nSample outputs:\n${outs.map((o) => `- ${o.slice(0, 140)}`).join("\n")}` },
          ],
        });
        let next: string | undefined;
        try { next = JSON.parse(prop.text.match(/\{[\s\S]*\}/s)?.[0] ?? "{}").system; } catch {}
        if (!next) break;
        current = next;
      }
    } catch (e: any) {
      if (e?.data?.kind === "AIBudgetLimit") stopped = "budget";
      else throw e;
    }
    return { history, best, spentNanos: spent, stopped, corpusSize: sample.length };
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
    return await ai.requests.rerun(ctx, args);
  },
});

export const listRequests = query({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return await ai.requests.list(ctx, { ...args, limit: 100 });
  },
});

export const lineage = query({
  args: { requestId: v.string() },
  handler: async (ctx, args) => {
    return await ai.requests.lineage(ctx, args);
  },
});

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    return await ai.users.list(ctx);
  },
});

export const listPrices = query({
  args: {},
  handler: async (ctx) => {
    return await ai.prices.list(ctx);
  },
});

export const listActions = query({
  args: {},
  handler: async (ctx) => {
    return await ai.actions.list(ctx);
  },
});

export const setPrice = mutation({
  args: {
    model: v.string(),
    inputNanosPerMTok: v.number(),
    outputNanosPerMTok: v.number(),
  },
  handler: async (ctx, args) => {
    await ai.prices.set(ctx, args);
  },
});

export const getModelPolicy = query({
  args: {},
  handler: async (ctx) => {
    return await ai.models.getPolicy(ctx);
  },
});

export const getGlobalStatus = query({
  args: {},
  handler: async (ctx) => {
    return await ai.global.status(ctx);
  },
});

export const setGlobalLimits = mutation({
  args: {
    dailySpendLimitNanos: v.optional(v.number()),
    lifetimeSpendLimitNanos: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
  },
  handler: async (ctx, args) => {
    await ai.global.setLimits(ctx, args);
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
  handler: async (ctx, args) => {
    await ai.models.setPolicy(ctx, args);
  },
});

export const setActionLimits = mutation({
  args: {
    name: v.string(),
    dailySpendLimitNanos: v.optional(v.number()),
    lifetimeSpendLimitNanos: v.optional(v.number()),
    dailyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
    disabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ai.actions.setLimits(ctx, args);
  },
});

export const deleteUser = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ai.users.delete(ctx, args);
  },
});

export const bumpUser = mutation({
  args: {
    userId: v.string(),
    dailyNanos: v.optional(v.number()),
    lifetimeNanos: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ai.users.bump(ctx, args);
  },
});

export const bumpAction = mutation({
  args: {
    name: v.string(),
    dailyNanos: v.optional(v.number()),
    lifetimeNanos: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ai.actions.bump(ctx, args);
  },
});

export const bumpGlobal = mutation({
  args: {
    dailyNanos: v.optional(v.number()),
    lifetimeNanos: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ai.global.bump(ctx, args);
  },
});

export const setLimits = mutation({
  args: {
    userId: v.string(),
    requestsPerMinute: v.optional(v.number()),
    dailySpendLimitNanos: v.optional(v.number()),
    lifetimeSpendLimitNanos: v.optional(v.number()),
    dailyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
    blocked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ai.users.setLimits(ctx, args);
  },
});
