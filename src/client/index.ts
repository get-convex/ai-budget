import type { Expand, FunctionReference } from "convex/server";
import { ConvexError, type GenericId } from "convex/values";
import { generateText, wrapLanguageModel, type LanguageModel } from "ai";
import { convexGateway } from "@convex-dev/ai-sdk-provider";
import type { api } from "../component/_generated/api";

// ---------- types ----------

type OpaqueIds<T> = T extends GenericId<infer _T> | string
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

export type AIGatewayApi = UseApi<typeof api>;

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

export type Message = { role: string; content: string };

export type ChatResult = {
  text: string;
  requestId: string;
  costCents: number;
  promptTokens: number;
  completionTokens: number;
};

// ---------- helpers ----------

function extractUsage(usage: any): {
  promptTokens: number;
  completionTokens: number;
} {
  return {
    promptTokens: usage?.inputTokens ?? usage?.promptTokens ?? 0,
    completionTokens: usage?.outputTokens ?? usage?.completionTokens ?? 0,
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

export class WorryFreeAI {
  public defaultModel: string;
  constructor(
    public component: AIGatewayApi,
    options?: { defaultModel?: string }
  ) {
    this.defaultModel = options?.defaultModel ?? "openai/gpt-4o-mini";
  }

  /**
   * One-shot chat through the AI Gateway with tracking + limits.
   * Call from an action.
   */
  async chat(
    ctx: RunMutationCtx,
    args: {
      userId: string;
      prompt?: string;
      messages?: Message[];
      model?: string;
      rerunOf?: string;
      /** Attribute spend to this action name. Defaults to the calling Convex action. */
      action?: string;
    }
  ): Promise<ChatResult> {
    const model = args.model ?? this.defaultModel;
    const messages: Message[] =
      args.messages ?? [{ role: "user", content: args.prompt ?? "" }];
    const started = await ctx.runMutation(this.component.lib.startRequest, {
      userId: args.userId,
      actionName: await resolveActionName(ctx, args.action),
      model,
      messages,
      rerunOf: args.rerunOf as any,
    });
    if (!started.allowed) {
      throw new ConvexError({
        kind: "AIGatewayLimit",
        code: started.code,
        reason: started.reason,
      });
    }
    const requestId = started.requestId;
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
      return { text: result.text, requestId, costCents, ...usage };
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
   */
  languageModel(
    ctx: RunMutationCtx,
    opts: { userId: string; model?: string; action?: string }
  ): LanguageModel {
    const modelId = opts.model ?? this.defaultModel;
    const component = this.component;

    const begin = async (params: any) => {
      const started = await ctx.runMutation(component.lib.startRequest, {
        userId: opts.userId,
        actionName: await resolveActionName(ctx, opts.action),
        model: modelId,
        messages: simplifyPrompt(params.prompt),
      });
      if (!started.allowed) {
        throw new ConvexError({
          kind: "AIGatewayLimit",
          code: started.code,
          reason: started.reason,
        });
      }
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
            const tapped = result.stream.pipeThrough(
              new TransformStream({
                transform(chunk: any, controller) {
                  if (chunk?.type === "text-delta") {
                    text += chunk.delta ?? chunk.textDelta ?? "";
                  }
                  if (chunk?.type === "finish") usage = chunk.usage;
                  controller.enqueue(chunk);
                },
                async flush() {
                  await finish(requestId, {
                    responseText: text,
                    ...extractUsage(usage),
                    latencyMs: Date.now() - start,
                  });
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
      blocked?: boolean;
    }
  ) {
    return ctx.runMutation(this.component.lib.setLimits, args);
  }

  async listActions(ctx: RunQueryCtx) {
    return ctx.runQuery(this.component.lib.listActions, {});
  }

  /** Delete a user and all their request rows. Returns rows removed. */
  async deleteUser(ctx: RunMutationCtx, args: { userId: string }) {
    return ctx.runMutation(this.component.lib.deleteUser, args);
  }

  async setActionLimits(
    ctx: RunMutationCtx,
    args: {
      name: string;
      dailySpendLimitCents?: number;
      lifetimeSpendLimitCents?: number;
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
