/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";
import shardedCounter from "@convex-dev/sharded-counter/test";
import rateLimiter from "@convex-dev/rate-limiter/test";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with the test convex instance.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function register<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(t: TestConvex<Schema>, name: string = "workflow") {
  t.registerComponent(name, schema, modules);
  shardedCounter.register(t, `${name}/shardedCounter`);
  rateLimiter.register(t, `${name}/rateLimiter`);
}
export default { register, schema, modules };
