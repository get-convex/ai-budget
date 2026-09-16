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
const evalStore = components.evaluations.lib;
const evalTags = (runId: string) => [
  { dimension: "evalRun", value: runId },
  { dimension: "workload", value: "evaluation" },
];

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

// Fire N REAL concurrent AI requests against a fresh, tightly-capped budget
// bucket (tag dimension "burst", one value per run). Reserve-then-settle
// admission is atomic under concurrency: the requests that fit the cap are
// admitted, the rest are rejected up front — they can't all spend the same
// remaining budget. Watch it live via listRequests({dimension:"burst"}).
const BURST_PROMPTS = [
  "Name a surprising animal fact.",
  "Give me a two-line haiku about databases.",
  "What's an underrated pizza topping?",
  "One-sentence pitch for a time-travel sitcom.",
  "Best keyboard shortcut nobody knows?",
  "Describe the color blue to someone who can't see.",
  "A fortune-cookie fortune for a programmer.",
  "Why do cats knock things off tables?",
  "Invent a name for a rock band of accountants.",
  "One weird tip for remembering names.",
  "What would a robot order at a coffee shop?",
  "Sum up the internet in five words.",
];

export const burst = action({
  args: {
    userId: v.string(),
    runId: v.string(),
    count: v.number(),
    budgetNanos: v.number(),
    model: v.optional(v.string()),
  },
  handler: async (ctx, { userId, runId, count, budgetNanos, model }) => {
    const n = Math.min(Math.max(1, Math.floor(count)), 20);
    // Cap this run's bucket, then race n real requests against it.
    await ai.tag("burst").setLimits(ctx, {
      value: runId,
      lifetimeSpendLimitNanos: budgetNanos,
    });
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        ai
          .chat(ctx, {
            userId,
            model,
            tags: [{ dimension: "burst", value: runId }],
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: BURST_PROMPTS[i % BURST_PROMPTS.length] },
            ],
          })
          .then(
            (r) => ({ index: i, ok: true as const, costNanos: r.costNanos, text: r.text }),
            (e: any) => ({
              index: i,
              ok: false as const,
              reason: String(e?.data?.reason ?? e?.message ?? e),
            })
          )
      )
    );
    const admitted = results.filter((r) => r.ok);
    return {
      runId,
      requested: n,
      admitted: admitted.length,
      rejected: n - admitted.length,
      totalCostNanos: admitted.reduce((s, r) => s + (r.ok ? r.costNanos ?? 0 : 0), 0),
      results,
    };
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
    const runId = await ctx.runMutation(evalStore.createRun, {
      kind: "matrix",
      configJson: JSON.stringify({ prompt, systems: sys, models: mods }),
      budgetTagDimension: "evalRun",
    });
    const caseId = await ctx.runMutation(evalStore.addCase, {
      runId,
      key: "prompt",
      inputJson: JSON.stringify({ prompt }),
    });
    const results = await Promise.all(
      combos.map(async ({ system, model }) => {
        try {
          const r = await ai.chat(ctx, {
            userId,
            model,
            action: "ai:experiment",
            tags: evalTags(runId),
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
          });
          const result = {
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
          await ctx.runMutation(evalStore.recordResult, {
            runId,
            caseId,
            candidate: system,
            model,
            outputJson: JSON.stringify({ text: r.text, requestId: r.requestId }),
            costNanos: r.costNanos,
          });
          return result;
        } catch (e: any) {
          const result = {
            system,
            model,
            error: String(e?.data?.reason ?? e?.message ?? e),
          };
          await ctx.runMutation(evalStore.recordResult, {
            runId,
            caseId,
            candidate: system,
            model,
            costNanos: 0,
            error: result.error,
          });
          return result;
        }
      })
    );
    await ctx.runMutation(evalStore.completeRun, {
      runId,
      status: "completed",
      summaryJson: JSON.stringify({ candidates: results.length }),
    });
    return results;
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
    const judgeModel = model ?? "openai/gpt-4o";
    const runId = await ctx.runMutation(evalStore.createRun, {
      kind: "judge",
      configJson: JSON.stringify({ prompt, candidates, criteria: rubric, model: judgeModel }),
      budgetTagDimension: "evalRun",
    });
    const caseId = await ctx.runMutation(evalStore.addCase, {
      runId,
      key: "candidates",
      inputJson: JSON.stringify({ prompt, candidates }),
    });
    const list = candidates
      .map((c) => `### Candidate ${c.label}\n${c.text}`)
      .join("\n\n");
    try {
      const res = await ai.chat(ctx, {
        userId: "judge",
        model: judgeModel,
        action: "ai:judge",
        tags: evalTags(runId),
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
      await ctx.runMutation(evalStore.recordResult, {
        runId,
        caseId,
        candidate: "judge",
        model: judgeModel,
        outputJson: JSON.stringify(parsed),
        verdict: parsed.winner ?? undefined,
        rationale: parsed.rationale ?? undefined,
        costNanos: res.costNanos,
      });
      await ctx.runMutation(evalStore.completeRun, {
        runId,
        status: "completed",
        summaryJson: JSON.stringify(parsed),
      });
      return { ...parsed, costNanos: res.costNanos };
    } catch (error) {
      await ctx.runMutation(evalStore.completeRun, {
        runId,
        status: (error as any)?.data?.kind === "AIBudgetLimit" ? "budget_exhausted" : "failed",
        error: String(error),
      });
      throw error;
    }
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

    const runId = await ctx.runMutation(evalStore.createRun, {
      kind: "backtest",
      configJson: JSON.stringify({
        action: targetAction,
        newSystem,
        criteria: rubric,
        model,
        sampleSize: sample.length,
      }),
      budgetTagDimension: "evalRun",
    });
    const caseIds: string[] = [];
    for (const [index, request] of sample.entries()) {
      caseIds.push(
        await ctx.runMutation(evalStore.addCase, {
          runId,
          key: `request-${index + 1}`,
          inputJson: JSON.stringify({
            messages: request.messages,
            userId: request.userId,
            model: request.model,
          }),
          expectedJson: JSON.stringify({ responseText: request.responseText }),
          sourceId: String(request._id),
        })
      );
    }

    const results = await Promise.all(
      sample.map(async (r: any, index: number) => {
        const convo = r.messages.filter((m: any) => m.role !== "system");
        try {
          const rr = await ai.chat(ctx, {
            userId: r.userId,
            model: model ?? r.model,
            action: "ai:backtest",
            tags: evalTags(runId),
            messages: [{ role: "system", content: newSystem }, ...convo],
          });
          const j = await ai.chat(ctx, {
            userId: "judge",
            model: "openai/gpt-4o",
            action: "ai:judge",
            tags: evalTags(runId),
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
          const result = {
            prompt: convo.map((m: any) => m.content).join(" / "),
            original: r.responseText,
            updated: rr.text,
            better: v2.better,
            why: v2.why,
            costNanos: (rr.costNanos ?? 0) + (j.costNanos ?? 0),
          };
          await ctx.runMutation(evalStore.recordResult, {
            runId,
            caseId: caseIds[index],
            candidate: newSystem,
            model: model ?? r.model,
            outputJson: JSON.stringify({ original: r.responseText, updated: rr.text }),
            verdict: v2.better,
            rationale: v2.why,
            costNanos: result.costNanos,
          });
          return result;
        } catch (e: any) {
          const result = {
            prompt: convo.map((m: any) => m.content).join(" / "),
            error: String(e?.data?.reason ?? e?.message ?? e),
          };
          await ctx.runMutation(evalStore.recordResult, {
            runId,
            caseId: caseIds[index],
            candidate: newSystem,
            model: model ?? r.model,
            costNanos: 0,
            error: result.error,
          });
          return result;
        }
      })
    );
    const summary = {
      results,
      total: results.length,
      improved: results.filter((r) => "better" in r && r.better === "new").length,
      regressed: results.filter((r) => "better" in r && r.better === "original").length,
    };
    await ctx.runMutation(evalStore.completeRun, {
      runId,
      status: "completed",
      summaryJson: JSON.stringify({
        total: summary.total,
        improved: summary.improved,
        regressed: summary.regressed,
      }),
    });
    return summary;
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

    const runId = await ctx.runMutation(evalStore.createRun, {
      kind: "evolve",
      configJson: JSON.stringify({
        action: targetAction,
        goal,
        criteria: rubric,
        seedSystem,
        rounds: maxRounds,
        sampleSize: sample.length,
        budgetNanos,
      }),
      budgetTagDimension: "evalRun",
    });
    const caseIds: string[] = [];
    for (const [index, item] of sample.entries()) {
      caseIds.push(
        await ctx.runMutation(evalStore.addCase, {
          runId,
          key: `request-${index + 1}`,
          inputJson: JSON.stringify({
            messages: item.convo,
            userId: item.userId,
            model: item.model,
          }),
        })
      );
    }
    if (budgetNanos !== undefined) {
      await ai.tag("evalRun").setLimits(ctx, {
        value: runId,
        lifetimeSpendLimitNanos: budgetNanos,
      });
    }

    let spent = 0;
    const chat = async (args: any) => {
      const r = await ai.chat(ctx, {
        action: "ai:evolve",
        tags: evalTags(runId),
        ...args,
      });
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
        const spentBeforeRound = spent;
        const { avg, outs } = await scoreSystem(current);
        history.push({ round: round + 1, system: current, score: avg, spentNanos: spent });
        await ctx.runMutation(evalStore.recordResult, {
          runId,
          candidate: current,
          outputJson: JSON.stringify({ outputs: outs, caseIds }),
          score: avg,
          costNanos: spent - spentBeforeRound,
        });
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
      else {
        await ctx.runMutation(evalStore.completeRun, {
          runId,
          status: "failed",
          error: String(e?.message ?? e),
        });
        throw e;
      }
    }
    const summary = { history, best, spentNanos: spent, stopped, corpusSize: sample.length };
    await ctx.runMutation(evalStore.completeRun, {
      runId,
      status: stopped === "budget" ? "budget_exhausted" : "completed",
      summaryJson: JSON.stringify(summary),
    });
    return summary;
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
  args: {
    userId: v.optional(v.string()),
    dimension: v.optional(v.string()),
    value: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ai.requests.list(ctx, { ...args, limit: 100 });
  },
});

// Reactive, app-owned views over the isolated Evaluation component. Production
// apps should add their normal admin authorization here before re-exporting them.
export const listEvaluationRuns = query({
  args: {},
  handler: async (ctx) => ctx.runQuery(evalStore.listRuns, { limit: 50 }),
});

export const getEvaluationRun = query({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const [run, cases, results] = await Promise.all([
      ctx.runQuery(evalStore.getRun, { runId }),
      ctx.runQuery(evalStore.listCases, { runId, limit: 500 }),
      ctx.runQuery(evalStore.listResults, { runId, limit: 500 }),
    ]);
    return { run, cases, results };
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

// Pull REAL per-token prices from OpenRouter (public API; ids match the
// gateway's provider/model naming) and store them via the component's setPrice.
// Prices are $/token → nanodollars per Mtok = $/token * 1e15. This is app/ops
// code: the component just stores whatever prices you give it.
export const syncPrices = action({
  args: {},
  handler: async (ctx) => {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    const { data } = (await res.json()) as { data: any[] };
    const byId = new Map(data.map((m) => [m.id, m]));
    const models = [
      "openai/gpt-4o-mini",
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5",
      "openai/gpt-5-mini",
    ];
    const updated: any[] = [];
    for (const model of models) {
      const p = byId.get(model)?.pricing;
      if (!p) continue;
      const inputNanosPerMTok = Math.round(Number(p.prompt) * 1e15);
      const outputNanosPerMTok = Math.round(Number(p.completion) * 1e15);
      await ai.prices.set(ctx, { model, inputNanosPerMTok, outputNanosPerMTok });
      updated.push({ model, inputNanosPerMTok, outputNanosPerMTok });
    }
    return { updated };
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
    monthlySpendLimitNanos: v.optional(v.number()),
    lifetimeSpendLimitNanos: v.optional(v.number()),
    dailyTokenLimit: v.optional(v.number()),
    monthlyTokenLimit: v.optional(v.number()),
    lifetimeTokenLimit: v.optional(v.number()),
    enforcement: v.optional(v.union(v.literal("hard"), v.literal("soft"))),
    blocked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ai.actions.setLimits(ctx, args);
  },
});

// Durable spend history for a bucket (per day or per month). Survives retention.
export const usageHistory = query({
  args: {
    dimension: v.string(),
    value: v.string(),
    period: v.union(v.literal("day"), v.literal("month")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { dimension, value, period, limit }) =>
    ai.tag(dimension).history(ctx, { value, period, limit }),
});

// Manual credit (negative) / debit (positive) against a bucket.
export const adjust = mutation({
  args: {
    dimension: v.string(),
    value: v.string(),
    deltaNanos: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { dimension, value, deltaNanos, reason }) =>
    ai.tag(dimension).adjust(ctx, { value, deltaNanos, reason }),
});

export const listAdjustments = query({
  args: { dimension: v.string(), value: v.string() },
  handler: async (ctx, { dimension, value }) =>
    ai.tag(dimension).adjustments(ctx, { value }),
});

export const setAlertDefaults = mutation({
  args: { warnAtPct: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await ai.global.setAlertDefaults(ctx, args);
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
  handler: async (ctx, args) => {
    await ai.users.setLimits(ctx, args);
  },
});
