import { httpRouter } from "convex/server";
import { expect, test, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } })),
  wrapLanguageModel: (options: unknown) => options,
}));
vi.mock("@convex-dev/ai-sdk-provider", () => ({ convexGateway: () => ({}) }));
import { AIBudget } from "./index";

const component = {
  lib: {
    startRequest: "start",
    finishRequest: "finish",
    setGlobalLimits: "global",
    setBucketLimits: "limits",
  },
} as any;
const makeCtx = (identity: any = { tokenIdentifier: "issuer|u", subject: "u" }) => ({
  auth: { getUserIdentity: async () => identity },
  runQuery: vi.fn(),
  runMutation: vi.fn(async (fn: string, _args: any) =>
    fn === "start"
      ? { allowed: true, requestId: "r", warnings: [], notices: [] }
      : { costNanos: 42 }
  ),
});

test("default identity includes the issuer and explicit IDs remain host-owned", async () => {
  const ai = new AIBudget(component);
  for (const tokenIdentifier of ["issuer-a|same", "issuer-b|same"]) {
    const ctx = makeCtx({ subject: "same", tokenIdentifier });
    await ai.begin(ctx as any, { model: "m" });
    expect(ctx.runMutation.mock.calls[0][1]).toMatchObject({
      userId: tokenIdentifier,
      legacyUserId: "same",
    });
  }
  const ctx = makeCtx(null);
  await ai.begin(ctx as any, { model: "m", userId: "service" });
  expect(ctx.runMutation.mock.calls[0][1].userId).toBe("service");
  expect(ctx.runMutation.mock.calls[0][1].legacyUserId).toBeUndefined();
  await expect(ai.begin(ctx as any, { model: "m" })).rejects.toThrow();
});

test("legacy subject keys require an explicit migration option", async () => {
  const ctx = makeCtx({ subject: "u" });
  await expect(new AIBudget(component).begin(ctx as any, { model: "m" })).rejects.toThrow();
  await new AIBudget(component, { identityKey: "subject" }).begin(ctx as any, { model: "m" });
  expect(ctx.runMutation.mock.calls[0][1].userId).toBe("u");
  expect(ctx.runMutation.mock.calls[0][1].legacyUserId).toBeUndefined();
});

test("raw Anthropic usage includes fresh, cache-read and cache-write tokens", async () => {
  const ctx = makeCtx();
  await new AIBudget(component).settle(ctx as any, {
    requestId: "r",
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 15 },
      output_tokens: 3,
    },
  });
  expect(ctx.runMutation.mock.calls[0][1]).toMatchObject({
    promptTokens: 130,
    cachedTokens: 100,
    cachedWriteTokens: 20,
    cachedWrite1hTokens: 5,
    completionTokens: 3,
  });
});

test("meter refuses to repeat a provider side effect on reused admission", async () => {
  const ctx = makeCtx();
  ctx.runMutation.mockResolvedValueOnce(
    { allowed: true, requestId: "r", reused: true, warnings: [], notices: [] } as any,
  );
  const run = vi.fn();
  await expect(
    new AIBudget(component).meter(ctx as any, {
      userId: "u",
      model: "m",
      messages: [],
      idempotencyKey: "job",
    }, run),
  ).rejects.toMatchObject({ data: { kind: "AIBudgetDuplicate", requestId: "r" } });
  expect(run).not.toHaveBeenCalled();
});

async function streamHarness(source: ReadableStream) {
  const ctx = makeCtx();
  const model = new AIBudget(component).languageModel(ctx as any, { userId: "u" }) as any;
  const result = await model.middleware.wrapStream({
    params: { prompt: [{ role: "user", content: "prompt" }] },
    doStream: async () => ({ stream: source }),
  });
  return { ctx, stream: result.stream as ReadableStream };
}
const finishes = (ctx: ReturnType<typeof makeCtx>) =>
  ctx.runMutation.mock.calls.filter(([fn]) => fn === "finish");

test("a normal stream records final authoritative usage once", async () => {
  const { ctx, stream } = await streamHarness(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "hello" });
        controller.enqueue({
          type: "finish",
          usage: { inputTokens: 10, outputTokens: 2 },
          providerMetadata: { convexGateway: { cost: 0.1 } },
        });
        controller.close();
      },
    }),
  );
  const reader = stream.getReader();
  while (!(await reader.read()).done) { /* consume */ }
  expect(finishes(ctx)).toHaveLength(1);
  expect(finishes(ctx)[0][1]).toMatchObject({
    promptTokens: 10,
    completionTokens: 2,
    costNanos: 100_000_000,
    responseText: "hello",
  });
});

test("stream cancellation settles without a transformer cancel hook", async () => {
  const { ctx, stream } = await streamHarness(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "partial" });
      },
    }),
  );
  const reader = stream.getReader();
  await reader.read();
  await reader.cancel("disconnect");
  expect(finishes(ctx)).toHaveLength(1);
  expect(finishes(ctx)[0][1]).toMatchObject({
    responseText: "partial",
    error: "cancelled: disconnect",
  });
});

test("upstream stream failures settle the tracked request", async () => {
  const { ctx, stream } = await streamHarness(
    new ReadableStream({
      pull(controller) {
        controller.error(new Error("upstream"));
      },
    }),
  );
  await expect(stream.getReader().read()).rejects.toThrow("upstream");
  expect(finishes(ctx)).toHaveLength(1);
  expect(finishes(ctx)[0][1].error).toContain("upstream");
});

test("an error chunk followed by final usage retains authoritative billing", async () => {
  const { ctx, stream } = await streamHarness(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "error", error: "provider error" });
        controller.enqueue({ type: "finish", usage: { inputTokens: 123, outputTokens: 456 } });
        controller.close();
      },
    }),
  );
  const reader = stream.getReader();
  while (!(await reader.read()).done) { /* consume */ }
  expect(finishes(ctx)).toHaveLength(1);
  expect(finishes(ctx)[0][1]).toMatchObject({
    error: "provider error",
    promptTokens: 123,
    completionTokens: 456,
  });
});

test("language model admission estimates the full text rather than truncated storage", async () => {
  const ctx = makeCtx();
  const model = new AIBudget(component).languageModel(ctx as any) as any;
  const prompt = "x".repeat(100_000);
  await model.middleware.wrapGenerate({
    params: { prompt: [{ role: "user", content: prompt }] },
    doGenerate: async () => ({ usage: { inputTokens: 10, outputTokens: 1 } }),
  });
  expect(ctx.runMutation.mock.calls[0][1].messages[0].content).toBe(prompt);
});

test("cookie-authorized dashboard mutations require same-origin JSON", async () => {
  const ctx = makeCtx();
  const http = httpRouter();
  new AIBudget(component).registerRoutes(http, { authorize: async () => true });
  const [handler] = http.lookup("/aibudget/api/global/setLimits", "POST")!;
  const invoke = (headers: Record<string, string>) =>
    (handler as any)._handler(
      ctx,
      new Request("https://app.test/aibudget/api/global/setLimits", {
        method: "POST",
        headers,
        body: "{\"dailySpendLimitNanos\":null}",
      }),
    );
  expect((await invoke({ origin: "https://evil.test", "content-type": "text/plain" })).status).toBe(
    403,
  );
  expect((await invoke({ origin: "https://app.test", "content-type": "text/plain" })).status).toBe(
    415,
  );
  expect(ctx.runMutation).not.toHaveBeenCalled();
  expect((await invoke({ origin: "https://app.test", "content-type": "application/json" })).status)
    .toBe(200);
  expect(ctx.runMutation.mock.calls[0][1]).toEqual({
    dailySpendLimitNanos: null,
    actorId: "issuer|u",
  });
});

test("SDK middleware reserves explicit bounds and limits provider output", async () => {
  const ctx = makeCtx();
  const model = new AIBudget(component).languageModel(ctx as any, {
    reservation: { costNanos: 1000, tokens: 300, maxOutputTokens: 100 },
  }) as any;
  const params = await model.middleware.transformParams({
    params: { maxOutputTokens: 500, prompt: [] },
  });
  expect(params.maxOutputTokens).toBe(100);
  await model.middleware.wrapGenerate({ params, doGenerate: async () => ({ usage: {} }) });
  expect(ctx.runMutation.mock.calls[0][1]).toMatchObject({
    estimatedCostNanos: 1000,
    estimatedTokens: 300,
  });
});

test("provider-level structured cache usage is normalized", async () => {
  const ctx = makeCtx();
  await new AIBudget(component).settle(ctx as any, {
    requestId: "r",
    usage: {
      inputTokens: { total: 130, cacheRead: 100, cacheWrite: 20, noCache: 10 },
      outputTokens: { total: 3 },
      raw: { cache_creation: { ephemeral_1h_input_tokens: 5 } },
    },
  });
  expect(ctx.runMutation.mock.calls[0][1]).toMatchObject({
    promptTokens: 130,
    cachedTokens: 100,
    cachedWriteTokens: 20,
    cachedWrite1hTokens: 5,
  });
});

test("admin wrappers derive the audit actor from the authenticated identity", async () => {
  const ctx = makeCtx();
  await new AIBudget(component).global.setLimits(ctx as any, { dailySpendLimitNanos: 1 });
  expect(ctx.runMutation.mock.calls[0][1]).toMatchObject({ actorId: "issuer|u" });
});
