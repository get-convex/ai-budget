import { defineApp } from "convex/server";
import aiBudget from "../../src/component/convex.config";
import agent from "@convex-dev/agent/convex.config";
import evaluations from "./evaluations/convex.config";

const app = defineApp();
app.use(aiBudget);
app.use(agent);
app.use(evaluations);
export default app;
