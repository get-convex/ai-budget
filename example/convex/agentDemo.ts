import { v } from "convex/values";
import { Agent } from "@convex-dev/agent";
import { action } from "./_generated/server";
import { components } from "./_generated/api";
import { AIBudget } from "../../src/client";

const ai = new AIBudget(components.aiBudget);

// This is feature #3: the @convex-dev/agent adapter. `ai.languageModel(ctx, …)`
// returns a standard AI SDK LanguageModel that enforces this user's budgets and
// records every generation — so it drops straight into the Agent component.
// Constructing the agent per-request binds it to the calling user, giving you
// per-user (and, via ctx.meta, per-action) attribution of all agent spend for
// free. Threads/messages are stored by the agent component; cost & caps by
// ai-budget.
export const agentChat = action({
  args: {
    userId: v.string(),
    prompt: v.string(),
    threadId: v.optional(v.string()),
  },
  handler: async (ctx, { userId, prompt, threadId }) => {
    const agent = new Agent(components.agent, {
      name: "budgeted-demo-agent",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      languageModel: ai.languageModel(ctx, { userId, action: "agentChat" }) as any,
      instructions: "You are a concise, friendly assistant. Keep replies short.",
    });
    const tId =
      threadId ?? (await agent.createThread(ctx, { userId })).threadId;
    const result = await agent.generateText(ctx, { threadId: tId }, { prompt });
    return { text: result.text, threadId: tId };
  },
});
