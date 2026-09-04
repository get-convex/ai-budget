import { httpRouter } from "convex/server";
import { components } from "./_generated/api";
import { AIBudget } from "../../src/client";

const ai = new AIBudget(components.aiBudget);
const http = httpRouter();

// Mount the component's built-in admin dashboard at /aibudget with ONE call.
// ⚠️ DEMO ONLY: `authorize: () => true` leaves it open. In production, gate it —
// e.g. `authorize: async (ctx) => (await ctx.auth.getUserIdentity())?.isAdmin`
// — or set the AI_BUDGET_DASHBOARD_TOKEN env var. See the README.
ai.registerRoutes(http, { authorize: async () => true });

export default http;
