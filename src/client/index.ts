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

/** Fired when a request is admitted over a *soft* limit. */
export type SoftLimitInfo = {
  userId: string;
  action?: string;
  requestId: string;
  warnings: string[];
};
export type AIBudgetOptions = {
  defaultModel?: string;
  /**
   * Called when a soft limit is exceeded (the request is still allowed). Lets
   * you surface budget warnings even on the languageModel/Agent path, where
   * they can't be returned. Errors thrown here are swallowed.
   */
  onSoftLimit?: (info: SoftLimitInfo) => void | Promise<void>;
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
  costCents: number;
  promptTokens: number;
  completionTokens: number;
  /** Soft-limit warnings raised at admission (empty unless a soft cap was hit). */
  warnings: string[];
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
} {
  return {
    promptTokens: toTokenCount(usage?.inputTokens ?? usage?.promptTokens),
    completionTokens: toTokenCount(usage?.outputTokens ?? usage?.completionTokens),
  };
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

export class AIBudget {
  public defaultModel: string;
  private onSoftLimit?: AIBudgetOptions["onSoftLimit"];
  constructor(
    public component: AIBudgetApi,
    options?: AIBudgetOptions
  ) {
    this.defaultModel = options?.defaultModel ?? "openai/gpt-4o-mini";
    this.onSoftLimit = options?.onSoftLimit;
  }

  private async fireSoftLimit(info: SoftLimitInfo) {
    if (info.warnings.length === 0 || !this.onSoftLimit) return;
    try {
      await this.onSoftLimit(info);
    } catch {
      // never let a callback error break a request
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
      model,
      messages,
      rerunOf: args.rerunOf as any,
    });
    if (!started.allowed) {
      throw new ConvexError({
        kind: "AIBudgetLimit",
        code: started.code,
        reason: started.reason,
      });
    }
    const requestId = started.requestId;
    const warnings = started.warnings;
    await this.fireSoftLimit({ userId, action: actionName, requestId, warnings });
    const start = Date.now();
    try {
      const result = await generateText({
        model: convexGateway(model),
        messages: messages as any,
      });
      const usage = extractUsage(result.usage);
      const { costCents } = await ctx.runMutation(
        this.component.lib.finishRequest,
        {
          requestId,
          responseText: result.text,
          ...usage,
          latencyMs: Date.now() - start,
        }
      );
      return { text: result.text, requestId, costCents, warnings, ...usage };
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
    opts: { userId?: string; model?: string; action?: string } = {}
  ): LanguageModel {
    const modelId = opts.model ?? this.defaultModel;
    const component = this.component;
    const fireSoftLimit = this.fireSoftLimit.bind(this);

    const begin = async (params: any) => {
      const userId = await resolveUserId(ctx, opts.userId);
      const actionName = await resolveActionName(ctx, opts.action);
      const started = await ctx.runMutation(component.lib.startRequest, {
        userId,
        actionName,
        model: modelId,
        messages: simplifyPrompt(params.prompt),
      });
      if (!started.allowed) {
        throw new ConvexError({
          kind: "AIBudgetLimit",
          code: started.code,
          reason: started.reason,
        });
      }
      await fireSoftLimit({
        userId,
        action: actionName,
        requestId: started.requestId,
        warnings: started.warnings,
      });
      return started.requestId;
    };
    const finish = async (
      requestId: any,
      fields: {
        responseText?: string;
        error?: string;
        promptTokens?: number;
        completionTokens?: number;
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

  /** Re-run a stored request, optionally with modified messages or model. */
  async rerun(
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
    });
  }

  // ---------- admin passthroughs ----------

  async listRequests(
    ctx: RunQueryCtx,
    args: { userId?: string; limit?: number } = {}
  ) {
    return ctx.runQuery(this.component.lib.listRequests, args);
  }

  /** The re-run chain for a request: ancestors up to the original, plus direct re-runs. */
  async lineage(ctx: RunQueryCtx, args: { requestId: string }) {
    return ctx.runQuery(this.component.lib.lineage, {
      requestId: args.requestId as any,
    });
  }

  async listUsers(ctx: RunQueryCtx) {
    return ctx.runQuery(this.component.lib.listUsers, {});
  }

  async listPrices(ctx: RunQueryCtx) {
    return ctx.runQuery(this.component.lib.listPrices, {});
  }

  async setLimits(
    ctx: RunMutationCtx,
    args: {
      userId: string;
      requestsPerMinute?: number;
      dailySpendLimitCents?: number;
      lifetimeSpendLimitCents?: number;
      dailyTokenLimit?: number;
      lifetimeTokenLimit?: number;
      enforcement?: "hard" | "soft";
      blocked?: boolean;
    }
  ) {
    return ctx.runMutation(this.component.lib.setLimits, args);
  }

  async listActions(ctx: RunQueryCtx) {
    return ctx.runQuery(this.component.lib.listActions, {});
  }

  /** One-time "approve another $X" bump for a user (daily is today-only). */
  async bumpUser(
    ctx: RunMutationCtx,
    args: { userId: string; dailyCents?: number; lifetimeCents?: number }
  ) {
    return ctx.runMutation(this.component.lib.bumpUser, args);
  }

  /** One-time bump for an action's budget. */
  async bumpAction(
    ctx: RunMutationCtx,
    args: { name: string; dailyCents?: number; lifetimeCents?: number }
  ) {
    return ctx.runMutation(this.component.lib.bumpAction, args);
  }

  /** One-time bump for the deployment-wide budget. */
  async bumpGlobal(
    ctx: RunMutationCtx,
    args: { dailyCents?: number; lifetimeCents?: number }
  ) {
    return ctx.runMutation(this.component.lib.bumpGlobal, args);
  }

  /** Delete a user and all their request rows. Returns rows removed. */
  async deleteUser(ctx: RunMutationCtx, args: { userId: string }) {
    return ctx.runMutation(this.component.lib.deleteUser, args);
  }

  /** Current model allow/deny policy. */
  async getModelPolicy(ctx: RunQueryCtx) {
    return ctx.runQuery(this.component.lib.getModelPolicy, {});
  }

  /** Deployment-wide spend cap status: limits + spend today/total. */
  async getGlobalStatus(ctx: RunQueryCtx) {
    return ctx.runQuery(this.component.lib.getGlobalStatus, {});
  }

  /**
   * Set a deployment-wide ("global") spend cap across all users and actions.
   * Enforced approximately (see the component docs) — a killswitch budget, not
   * an exact per-request reservation. Pass a field as `undefined` to clear it.
   */
  async setGlobalLimits(
    ctx: RunMutationCtx,
    args: {
      dailySpendLimitCents?: number;
      lifetimeSpendLimitCents?: number;
      enforcement?: "hard" | "soft";
    }
  ) {
    return ctx.runMutation(this.component.lib.setGlobalLimits, args);
  }

  /**
   * Restrict which models may be used component-wide.
   * - `open`: any model (default)
   * - `allowlist`: only `models` are allowed
   * - `denylist`: any model except `models`
   */
  async setModelPolicy(
    ctx: RunMutationCtx,
    args: { mode: "open" | "allowlist" | "denylist"; models: string[] }
  ) {
    return ctx.runMutation(this.component.lib.setModelPolicy, args);
  }

  async setActionLimits(
    ctx: RunMutationCtx,
    args: {
      name: string;
      dailySpendLimitCents?: number;
      lifetimeSpendLimitCents?: number;
      dailyTokenLimit?: number;
      lifetimeTokenLimit?: number;
      enforcement?: "hard" | "soft";
      disabled?: boolean;
    }
  ) {
    return ctx.runMutation(this.component.lib.setActionLimits, args);
  }

  async setPrice(
    ctx: RunMutationCtx,
    args: { model: string; inputCentsPerMTok: number; outputCentsPerMTok: number }
  ) {
    return ctx.runMutation(this.component.lib.setPrice, args);
  }
}

/** @deprecated Renamed to `AIBudget`. */
export const WorryFreeAI = AIBudget;
