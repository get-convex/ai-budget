import type { Expand, FunctionReference } from "convex/server";
import { ConvexError, type GenericId } from "convex/values";
import { generateText, wrapLanguageModel, type LanguageModel } from "ai";
import { convexGateway } from "@convex-dev/ai-sdk-provider";
import type { api } from "../component/_generated/api";

// ---------- types ----------

// Map branded document Ids to plain strings across the component boundary.
// Note: only GenericId, not `string` — widening every string (and string-literal
// union like "hard"|"soft") to `string` breaks structural matching of returns.
type OpaqueIds<T> = T extends GenericId<infer _T>
  ? string
  : T extends (infer U)[]
    ? OpaqueIds<U>[]
    : T extends ArrayBuffer
      ? ArrayBuffer
      : T extends object
        ? { [K in keyof T]: OpaqueIds<T[K]> }
        : T;

type UseApi<API> = Expand<{
  [mod in keyof API]: API[mod] extends FunctionReference<
    infer FType,
    "public",
    infer FArgs,
    infer FReturnType,
    infer FComponentPath
  >
    ? FunctionReference<
        FType,
        "internal",
        OpaqueIds<FArgs>,
        OpaqueIds<FReturnType>,
        FComponentPath
      >
    : UseApi<API[mod]>;
}>;

export type AIBudgetApi = UseApi<typeof api>;
/** @deprecated use AIBudgetApi */
export type AIGatewayApi = AIBudgetApi;

/**
 * One attribution tag: a (dimension, value) pair, e.g. {dimension:"customer",
 * value:"acme"}. `user` and `action` are built-in dimensions (set via
 * userId/action); use tags for anything else — team, project, tenant, env, ….
 * Any tagged bucket can carry its own budget (see `ai.tag(dimension)`).
 */
export type Tag = { dimension: string; value: string };

/** Common shape for budget-event callbacks. */
export type BudgetEventInfo = {
  userId: string;
  action?: string;
  tags?: Tag[];
  requestId?: string;
  /** soft-cap warnings (onSoftLimit) or approaching-cap notices (onThreshold). */
  messages: string[];
  /** rejection code/reason (onLimitReached only). */
  code?: string;
  reason?: string;
};
/** @deprecated use BudgetEventInfo */
export type SoftLimitInfo = BudgetEventInfo & { warnings: string[] };
export type AIBudgetOptions = {
  defaultModel?: string;
  /**
   * A *soft* limit was exceeded (request still allowed). Lets you surface budget
   * warnings even on the languageModel/Agent path where they can't be returned.
   * Errors thrown in any of these callbacks are swallowed.
   */
  onSoftLimit?: (info: SoftLimitInfo) => void | Promise<void>;
  /** Usage crossed a bucket's warnAtPct threshold (approaching a cap). */
  onThreshold?: (info: BudgetEventInfo) => void | Promise<void>;
  /** A *hard* limit blocked the request (fires just before chat/model throws). */
  onLimitReached?: (info: BudgetEventInfo) => void | Promise<void>;
};

type RunQueryCtx = {
  runQuery: <Query extends FunctionReference<"query", "internal">>(
    query: Query,
    args: Query["_args"]
  ) => Promise<Query["_returnType"]>;
};
type RunMutationCtx = RunQueryCtx & {
  runMutation: <M extends FunctionReference<"mutation", "internal">>(
    mutation: M,
    args: M["_args"]
  ) => Promise<M["_returnType"]>;
  meta?: { getFunctionMetadata(): Promise<{ name: string }> };
  auth?: { getUserIdentity(): Promise<{ subject?: string } | null> };
};

// The calling Convex action's name (e.g. "ai:sendMessage"), unless overridden.
async function resolveActionName(
  ctx: RunMutationCtx,
  explicit?: string
): Promise<string | undefined> {
  if (explicit !== undefined) return explicit;
  try {
    return (await ctx.meta?.getFunctionMetadata())?.name;
  } catch {
    return undefined;
  }
}

// The user this call is billed to. If not passed explicitly, it's the
// authenticated caller (ctx.auth.getUserIdentity().subject) — so budgets are
// server-derived by default and can't be spoofed by a client-supplied id.
async function resolveUserId(
  ctx: RunMutationCtx,
  explicit?: string
): Promise<string> {
  if (explicit !== undefined) return explicit;
  const identity = await ctx.auth?.getUserIdentity?.();
  if (identity?.subject) return identity.subject;
  throw new Error(
    "ai-budget: no `userId` was passed and there is no authenticated user " +
      "(ctx.auth.getUserIdentity() returned null). Either authenticate the " +
      "request or pass an explicit `userId`."
  );
}

export type Message = { role: string; content: string };

export type ChatResult = {
  text: string;
  requestId: string;
  costNanos: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Soft-limit warnings raised at admission (empty unless a soft cap was hit). */
  warnings: string[];
  /** Approaching-cap notices (empty unless a warnAtPct threshold was crossed). */
  notices: string[];
};

// ---------- helpers ----------

// Token counts across AI SDK versions come as plain numbers or, in v7, as a
// structured breakdown like { reasoning, text, total }. Coerce either to a number.
function toTokenCount(x: any): number {
  if (typeof x === "number") return Number.isFinite(x) ? x : 0;
  if (x && typeof x === "object") return toTokenCount(x.total ?? x.text ?? 0);
  return 0;
}

function extractUsage(usage: any): {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
} {
  return {
    promptTokens: toTokenCount(usage?.inputTokens ?? usage?.promptTokens),
    completionTokens: toTokenCount(usage?.outputTokens ?? usage?.completionTokens),
    // cached prompt tokens. The Convex gateway reports these at
    // `usage.inputTokenDetails.cacheReadTokens`; the other paths cover AI SDK v5
    // (`cachedInputTokens`) and raw OpenAI-compatible shapes.
    cachedTokens: toTokenCount(
      usage?.inputTokenDetails?.cacheReadTokens ??
        usage?.cachedInputTokens ??
        usage?.promptTokensDetails?.cachedTokens ??
        usage?.prompt_tokens_details?.cached_tokens ??
        usage?.cached_tokens
    ),
  };
}

// The gateway doesn't report a dollar cost today, but if a future response ever
// carries an unambiguous nanodollar cost we pass it straight through as
// authoritative (finishRequest prefers it over the token-based estimate). Only
// an explicitly nano-denominated field is trusted — a bare `cost` could be in
// dollars and silently mis-bill by 1e9×.
function extractGatewayCostNanos(result: any): number | undefined {
  const meta = result?.providerMetadata?.convexGateway;
  const candidates = [meta?.costNanos, result?.usage?.costNanos];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c;
  }
  return undefined;
}

// Flatten an AI SDK prompt (roles + content parts) into simple storable messages.
function simplifyPrompt(prompt: any): Message[] {
  if (!Array.isArray(prompt)) return [];
  return prompt.map((m: any) => {
    let content: string;
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .map((part: any) =>
          part?.type === "text" ? part.text : JSON.stringify(part)
        )
        .join("");
    } else {
      content = JSON.stringify(m.content);
    }
    return { role: String(m.role), content };
  });
}

function extractText(result: any): string {
  if (typeof result?.text === "string") return result.text;
  if (Array.isArray(result?.content)) {
    return result.content
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text)
      .join("");
  }
  return "";
}

// ---------- client ----------

/** Limits/controls settable on any budget bucket (user, action, or tag). */
export type BucketLimits = {
  requestsPerMinute?: number;
  maxConcurrent?: number;
  dailySpendLimitNanos?: number;
  monthlySpendLimitNanos?: number;
  lifetimeSpendLimitNanos?: number;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  lifetimeTokenLimit?: number;
  /** Fire an approaching-limit alert at this fraction of a cap (e.g. 0.8). */
  warnAtPct?: number;
  enforcement?: "hard" | "soft";
  blocked?: boolean;
};
/** One-time bump amounts, added on top of a standing cap. */
export type BumpArgs = {
  dailyNanos?: number;
  monthlyNanos?: number;
  lifetimeNanos?: number;
};

export class AIBudget {
  public defaultModel: string;
  private onSoftLimit?: AIBudgetOptions["onSoftLimit"];
  private onThreshold?: AIBudgetOptions["onThreshold"];
  private onLimitReached?: AIBudgetOptions["onLimitReached"];
  constructor(
    public component: AIBudgetApi,
    options?: AIBudgetOptions
  ) {
    this.defaultModel = options?.defaultModel ?? "openai/gpt-4o-mini";
    this.onSoftLimit = options?.onSoftLimit;
    this.onThreshold = options?.onThreshold;
    this.onLimitReached = options?.onLimitReached;
  }

  // Fire the soft-limit + threshold callbacks from a startRequest result.
  private async fireBudgetEvents(
    base: Omit<BudgetEventInfo, "messages">,
    warnings: string[],
    notices: string[]
  ) {
    if (warnings.length > 0 && this.onSoftLimit) {
      try {
        await this.onSoftLimit({ ...base, messages: warnings, warnings });
      } catch {
        /* never let a callback error break a request */
      }
    }
    if (notices.length > 0 && this.onThreshold) {
      try {
        await this.onThreshold({ ...base, messages: notices });
      } catch {
        /* swallow */
      }
    }
  }

  private async fireLimitReached(info: BudgetEventInfo) {
    if (!this.onLimitReached) return;
    try {
      await this.onLimitReached(info);
    } catch {
      /* swallow */
    }
  }

  /**
   * One-shot chat through the AI Gateway with tracking + limits.
   * Call from an action. `userId` defaults to the authenticated caller.
   */
  async chat(
    ctx: RunMutationCtx,
    args: {
      /** Whom to bill. Defaults to the authenticated user (ctx.auth). */
      userId?: string;
      prompt?: string;
      messages?: Message[];
      model?: string;
      rerunOf?: string;
      /** Attribute spend to this action name. Defaults to the calling Convex action. */
      action?: string;
      /** Extra attribution dimensions to bill/limit (team, customer, env, …). */
      tags?: Tag[];
    } = {}
  ): Promise<ChatResult> {
    const model = args.model ?? this.defaultModel;
    const userId = await resolveUserId(ctx, args.userId);
    const actionName = await resolveActionName(ctx, args.action);
    const messages: Message[] =
      args.messages ?? [{ role: "user", content: args.prompt ?? "" }];
    const started = await ctx.runMutation(this.component.lib.startRequest, {
      userId,
      actionName,
      tags: args.tags,
      model,
      messages,
      rerunOf: args.rerunOf as any,
    });
    if (!started.allowed) {
      await this.fireLimitReached({
        userId,
        action: actionName,
        tags: args.tags,
        messages: [started.reason],
        code: started.code,
        reason: started.reason,
      });
      throw new ConvexError({
        kind: "AIBudgetLimit",
        code: started.code,
        reason: started.reason,
      });
    }
    const requestId = started.requestId;
    const warnings = started.warnings;
    const notices = started.notices;
    await this.fireBudgetEvents(
      { userId, action: actionName, tags: args.tags, requestId },
      warnings,
      notices
    );
    const start = Date.now();
    try {
      // The full chain (incl. system) is stored on the request for audit/replay,
      // but the AI SDK wants system prompts in the `system` option, not messages.
      const system =
        messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n\n") || undefined;
      const convo = messages.filter((m) => m.role !== "system");
      const result = await generateText({
        model: convexGateway(model),
        ...(system ? { system } : {}),
        messages: convo as any,
      });
      const usage = extractUsage(result.usage);
      const { costNanos } = await ctx.runMutation(
        this.component.lib.finishRequest,
        {
          requestId,
          responseText: result.text,
          ...usage,
          costNanos: extractGatewayCostNanos(result),
          latencyMs: Date.now() - start,
        }
      );
      return { text: result.text, requestId, costNanos, warnings, notices, ...usage };
    } catch (e) {
      await ctx.runMutation(this.component.lib.finishRequest, {
        requestId,
        error: String(e),
        latencyMs: Date.now() - start,
      });
      throw e;
    }
  }

  /**
   * An AI SDK LanguageModel that enforces limits and records usage/cost for
   * `userId` on every call. Drop it into `generateText`, `streamText`, or the
   * Convex Agent component (`new Agent(components.agent, { languageModel })`).
   * `userId` defaults to the authenticated caller (ctx.auth).
   */
  languageModel(
    ctx: RunMutationCtx,
    opts: {
      userId?: string;
      model?: string;
      action?: string;
      /** Extra attribution dimensions to bill/limit (team, customer, env, …). */
      tags?: Tag[];
    } = {}
  ): LanguageModel {
    const modelId = opts.model ?? this.defaultModel;
    const component = this.component;
    const fireBudgetEvents = this.fireBudgetEvents.bind(this);
    const fireLimitReached = this.fireLimitReached.bind(this);

    const begin = async (params: any) => {
      const userId = await resolveUserId(ctx, opts.userId);
      const actionName = await resolveActionName(ctx, opts.action);
      const base = { userId, action: actionName, tags: opts.tags };
      const started = await ctx.runMutation(component.lib.startRequest, {
        userId,
        actionName,
        tags: opts.tags,
        model: modelId,
        messages: simplifyPrompt(params.prompt),
      });
      if (!started.allowed) {
        await fireLimitReached({
          ...base,
          messages: [started.reason],
          code: started.code,
          reason: started.reason,
        });
        throw new ConvexError({
          kind: "AIBudgetLimit",
          code: started.code,
          reason: started.reason,
        });
      }
      await fireBudgetEvents(
        { ...base, requestId: started.requestId },
        started.warnings,
        started.notices
      );
      return started.requestId;
    };
    const finish = async (
      requestId: any,
      fields: {
        responseText?: string;
        error?: string;
        promptTokens?: number;
        completionTokens?: number;
        cachedTokens?: number;
        costNanos?: number;
        latencyMs?: number;
      }
    ) => ctx.runMutation(component.lib.finishRequest, { requestId, ...fields });

    return wrapLanguageModel({
      model: convexGateway(modelId) as any,
      middleware: {
        wrapGenerate: async ({ doGenerate, params }: any) => {
          const requestId = await begin(params);
          const start = Date.now();
          try {
            const result = await doGenerate();
            await finish(requestId, {
              responseText: extractText(result),
              ...extractUsage(result.usage),
              costNanos: extractGatewayCostNanos(result),
              latencyMs: Date.now() - start,
            });
            return result;
          } catch (e) {
            await finish(requestId, {
              error: String(e),
              latencyMs: Date.now() - start,
            });
            throw e;
          }
        },
        wrapStream: async ({ doStream, params }: any) => {
          const requestId = await begin(params);
          const start = Date.now();
          let text = "";
          let usage: any = undefined;
          try {
            const result = await doStream();
            // finishRequest is idempotent (terminal-guarded server-side), so
            // settling from multiple stream outcomes — normal close, an error
            // chunk, or a cancel — is safe: the first wins, the rest no-op.
            // Without this an errored or abandoned stream would never settle and
            // its real usage would be lost (recorded as free by the reconciler).
            let settled = false;
            const settle = (error?: string) => {
              if (settled) return;
              settled = true;
              return finish(requestId, {
                responseText: text,
                error,
                ...extractUsage(usage),
                latencyMs: Date.now() - start,
              });
            };
            const tapped = result.stream.pipeThrough(
              new TransformStream({
                transform(chunk: any, controller) {
                  if (chunk?.type === "text-delta") {
                    text += chunk.delta ?? chunk.textDelta ?? "";
                  }
                  if (chunk?.type === "finish") usage = chunk.usage;
                  if (chunk?.type === "error") void settle(String(chunk.error));
                  controller.enqueue(chunk);
                },
                async flush() {
                  await settle();
                },
              })
            );
            return { ...result, stream: tapped };
          } catch (e) {
            await finish(requestId, {
              error: String(e),
              latencyMs: Date.now() - start,
            });
            throw e;
          }
        },
      } as any,
    }) as LanguageModel;
  }

  private async rerunImpl(
    ctx: RunMutationCtx,
    args: { requestId: string; messages?: Message[]; model?: string }
  ): Promise<ChatResult> {
    const original = await ctx.runQuery(this.component.lib.getRequest, {
      requestId: args.requestId as any,
    });
    if (!original) throw new Error("Unknown request");
    return this.chat(ctx, {
      userId: original.userId,
      model: args.model ?? original.model,
      messages: args.messages ?? original.messages,
      rerunOf: args.requestId,
      action: original.actionName,
      tags: original.tags,
    });
  }

  // ---------- namespaced admin API ----------

  /** The request audit log, replay, and re-run lineage. */
  get requests() {
    const c = this.component;
    return {
      /** Filter by userId, or by any {dimension, value} (incl. custom tags). */
      list: (
        ctx: RunQueryCtx,
        args: {
          userId?: string;
          dimension?: string;
          value?: string;
          limit?: number;
        } = {}
      ) => ctx.runQuery(c.lib.listRequests, args),
      /** Ancestors up to the original, plus direct re-runs. */
      lineage: (ctx: RunQueryCtx, args: { requestId: string }) =>
        ctx.runQuery(c.lib.lineage, { requestId: args.requestId as any }),
      /** Replay a stored request, optionally with edited messages/model. */
      rerun: (
        ctx: RunMutationCtx,
        args: { requestId: string; messages?: Message[]; model?: string }
      ) => this.rerunImpl(ctx, args),
    };
  }

  /**
   * Budgets and controls for an arbitrary attribution dimension — the
   * generalization of `users`/`actions`. Give it any dimension name (team,
   * project, tenant, customer, env, feature, …) and set caps per value:
   *
   *   ai.tag("customer").setLimits(ctx, { value: "acme", monthlySpendLimitNanos });
   *   ai.tag("customer").history(ctx, { value: "acme", period: "day" });
   *
   * Attribute a call to it by passing `tags` to `chat`/`languageModel`.
   */
  tag(dimension: string) {
    return this.dimensionApi(dimension, (a: { value: string }) => a.value);
  }

  // Shared implementation behind tag()/users/actions. `key` maps the namespace's
  // id field (value/userId/name) to the bucket value.
  private dimensionApi<A extends Record<string, any>>(
    dimension: string,
    key: (a: A) => string
  ) {
    const c = this.component;
    return {
      /** All buckets in this dimension. */
      list: (ctx: RunQueryCtx) => ctx.runQuery(c.lib.listBuckets, { dimension }),
      /** One bucket's limits + spend (null if it has none yet). */
      get: (ctx: RunQueryCtx, args: A) =>
        ctx.runQuery(c.lib.getBucket, { dimension, value: key(args) }),
      setLimits: (ctx: RunMutationCtx, args: A & BucketLimits) => {
        const { value, userId, name, ...limits } = args as any;
        return ctx.runMutation(c.lib.setBucketLimits, {
          dimension,
          value: key(args),
          ...limits,
        });
      },
      /** One-time "approve another $X" bump (daily/monthly reset with the window). */
      bump: (ctx: RunMutationCtx, args: A & BumpArgs) =>
        ctx.runMutation(c.lib.bumpBucket, {
          dimension,
          value: key(args),
          dailyNanos: args.dailyNanos,
          monthlyNanos: args.monthlyNanos,
          lifetimeNanos: args.lifetimeNanos,
        }),
      /** Manually credit (negative) or debit (positive) this bucket. */
      adjust: (
        ctx: RunMutationCtx,
        args: A & { deltaNanos: number; tokens?: number; reason?: string }
      ) =>
        ctx.runMutation(c.lib.adjustBucket, {
          dimension,
          value: key(args),
          deltaNanos: args.deltaNanos,
          tokens: args.tokens,
          reason: args.reason,
        }),
      /** Durable spend history for this bucket (per day or per month). */
      history: (
        ctx: RunQueryCtx,
        args: A & { period?: "day" | "month"; limit?: number }
      ) =>
        ctx.runQuery(c.lib.usageHistory, {
          dimension,
          value: key(args),
          period: args.period ?? "day",
          limit: args.limit,
        }),
      /** Manual-adjustment audit log for this bucket. */
      adjustments: (ctx: RunQueryCtx, args: A & { limit?: number }) =>
        ctx.runQuery(c.lib.listAdjustments, {
          dimension,
          value: key(args),
          limit: args.limit,
        }),
      /** Delete the bucket (for "user", also its request rows). */
      delete: (ctx: RunMutationCtx, args: A) =>
        ctx.runMutation(c.lib.deleteBucket, { dimension, value: key(args) }),
    };
  }

  /** Per-user budgets and controls — sugar over the "user" dimension. */
  get users() {
    return this.dimensionApi<{ userId: string }>("user", (a) => a.userId);
  }

  /** Per-action (per-feature) budgets — sugar over the "action" dimension. */
  get actions() {
    return this.dimensionApi<{ name: string }>("action", (a) => a.name);
  }

  /** The deployment-wide budget, alerts, and retention config. */
  get global() {
    const c = this.component;
    return {
      /** Limits + spend today/total. */
      status: (ctx: RunQueryCtx) => ctx.runQuery(c.lib.getGlobalStatus, {}),
      /** A killswitch spend cap across all users/actions (enforced approximately). */
      setLimits: (
        ctx: RunMutationCtx,
        args: {
          dailySpendLimitNanos?: number;
          lifetimeSpendLimitNanos?: number;
          enforcement?: "hard" | "soft";
        }
      ) => ctx.runMutation(c.lib.setGlobalLimits, args),
      bump: (
        ctx: RunMutationCtx,
        args: { dailyNanos?: number; lifetimeNanos?: number }
      ) => ctx.runMutation(c.lib.bumpGlobal, args),
      /** Default approaching-limit alert threshold (fraction of a cap, e.g. 0.8). */
      setAlertDefaults: (ctx: RunMutationCtx, args: { warnAtPct?: number }) =>
        ctx.runMutation(c.lib.setAlertDefaults, args),
      /** Request-row retention window in ms (default 1h; 0 disables). */
      setRetention: (ctx: RunMutationCtx, args: { retentionMs: number }) =>
        ctx.runMutation(c.lib.setRetention, args),
    };
  }

  /** Model allow/deny policy. */
  get models() {
    const c = this.component;
    return {
      getPolicy: (ctx: RunQueryCtx) => ctx.runQuery(c.lib.getModelPolicy, {}),
      /** mode: "open" | "allowlist" (only these) | "denylist" (all but these). */
      setPolicy: (
        ctx: RunMutationCtx,
        args: { mode: "open" | "allowlist" | "denylist"; models: string[] }
      ) => ctx.runMutation(c.lib.setModelPolicy, args),
    };
  }

  /** Per-model prices (cents per million tokens). */
  get prices() {
    const c = this.component;
    return {
      list: (ctx: RunQueryCtx) => ctx.runQuery(c.lib.listPrices, {}),
      set: (
        ctx: RunMutationCtx,
        args: {
          model: string;
          inputNanosPerMTok: number;
          outputNanosPerMTok: number;
          /** Cache-read rate; defaults to a discount off input if omitted. */
          cachedNanosPerMTok?: number;
        }
      ) => ctx.runMutation(c.lib.setPrice, args),
    };
  }
}

/** @deprecated Renamed to `AIBudget`. */
export const WorryFreeAI = AIBudget;
