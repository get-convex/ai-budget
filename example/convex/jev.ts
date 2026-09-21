import { v } from "convex/values";
import { action } from "./_generated/server";
import { components } from "./_generated/api";
import { AIBudget } from "../../src/client";

const budget = new AIBudget(components.aiBudget);
const model = "typesafe/jev-1.13";

export const classify = action({
  args: { userId: v.string(), text: v.string() },
  returns: v.object({
    requestId: v.string(),
    choice: v.string(),
    costNanos: v.number(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    gatewayId: v.string(),
  }),
  handler: async (ctx, { userId, text }) => {
    if (!text.trim() || text.length > 4000) {
      throw new Error("Enter between 1 and 4000 characters.");
    }
    // Budgeted structured decision through the production AI Gateway. `decisions`
    // handles auth, the /alpha/decisions call, and authoritative cost tracking.
    const result = await budget.decisions(ctx, {
      userId,
      model,
      action: "jev:classify",
      tags: [{ dimension: "gateway", value: "prod" }],
      estimatedCostNanos: 1_000_000,
      state: text,
      questions: {
        category: {
          type: "choice",
          instructions: "Classify this customer support request.",
          criteria: {
            billing: "Payments, invoices, refunds, or subscriptions",
            technical: "Errors, bugs, or problems using the product",
            other: "Anything else",
          },
        },
      },
    });
    const choice = result.answers?.category?.choice;
    if (!["billing", "technical", "other"].includes(choice)) {
      throw new Error("Jev returned an unexpected category.");
    }
    const gatewayId =
      typeof result.response?.body?.id === "string" ? result.response.body.id : "";
    return {
      requestId: result.requestId,
      choice,
      costNanos: result.costNanos,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      gatewayId,
    };
  },
});
