import { test, expect, vi } from "vitest";
import { httpRouter } from "convex/server";
import { AIBudget } from "./index";

test("webhook resolver can verify the exact raw body before settlement", async () => {
  const budget = new AIBudget({} as any);
  const settle = vi.spyOn(budget, "settle").mockResolvedValue({ costNanos: 123 });
  const http = httpRouter();
  const raw = '{ "id": "job", "cost": 123 }\n';
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-secret"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  budget.registerWebhook(http, {
    resolve: async (_ctx, request, body) => {
      const bytes = await request.arrayBuffer();
      if (!await crypto.subtle.verify("HMAC", key, signature, bytes)) return null;
      expect(body.id).toBe("job");
      return { requestId: "request", costNanos: body.cost };
    },
  });
  const [handler] = http.lookup("/aibudget/webhook", "POST")!;
  const response = await (handler as any)._handler({}, new Request("https://example.test/aibudget/webhook", {
    method: "POST", body: raw,
  }));
  expect(response.status).toBe(200);
  expect(settle).toHaveBeenCalledOnce();
  const rejected = await (handler as any)._handler({}, new Request("https://example.test/aibudget/webhook", {
    method: "POST", body: raw.replace("123", "999"),
  }));
  expect(rejected.status).toBe(202);
  expect(settle).toHaveBeenCalledOnce();
});
