import { defineApp } from "convex/server";
import aiBudget from "../../src/component/convex.config";
import agent from "@convex-dev/agent/convex.config";

const app = defineApp();
app.use(aiBudget);
app.use(agent);
export default app;
