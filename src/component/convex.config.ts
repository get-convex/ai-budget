import { defineComponent } from "convex/server";
import shardedCounter from "@convex-dev/sharded-counter/convex.config";

const component = defineComponent("aiBudget");
// Global spend totals use a sharded counter for high write throughput.
component.use(shardedCounter);
export default component;
