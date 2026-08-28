import { defineApp } from "convex/server";
import aiBudget from "../../src/component/convex.config";

const app = defineApp();
app.use(aiBudget);
export default app;
