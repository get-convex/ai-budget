/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      adjustBucket: FunctionReference<
        "mutation",
        "internal",
        {
          deltaNanos: number;
          dimension: string;
          reason?: string;
          tokens?: number;
          value: string;
        },
        null,
        Name
      >;
      bumpBucket: FunctionReference<
        "mutation",
        "internal",
        {
          dailyNanos?: number;
          dimension: string;
          lifetimeNanos?: number;
          monthlyNanos?: number;
          value: string;
        },
        null,
        Name
      >;
      bumpGlobal: FunctionReference<
        "mutation",
        "internal",
        { dailyNanos?: number; lifetimeNanos?: number; monthlyNanos?: number },
        null,
        Name
      >;
      deleteBucket: FunctionReference<
        "mutation",
        "internal",
        { dimension: string; value: string },
        { deletedThisBatch: number; done: boolean },
        Name
      >;
      finishRequest: FunctionReference<
        "mutation",
        "internal",
        {
          cachedTokens?: number;
          completionTokens?: number;
          costNanos?: number;
          error?: string;
          latencyMs?: number;
          promptTokens?: number;
          requestId: string;
          responseText?: string;
        },
        { costNanos: number },
        Name
      >;
      getBucket: FunctionReference<
        "query",
        "internal",
        { dimension: string; value: string },
        any,
        Name
      >;
      getGlobalStatus: FunctionReference<
        "query",
        "internal",
        {},
        {
          dailySpendLimitNanos: number | null;
          defaultWarnAtPct: number | null;
          enforcement: "hard" | "soft";
          lifetimeSpendLimitNanos: number | null;
          retentionMs: number | null;
          spentTodayNanos: number;
          spentTotalNanos: number;
        },
        Name
      >;
      getModelPolicy: FunctionReference<
        "query",
        "internal",
        {},
        { mode: "open" | "allowlist" | "denylist"; models: Array<string> },
        Name
      >;
      getRequest: FunctionReference<
        "query",
        "internal",
        { requestId: string },
        any,
        Name
      >;
      lineage: FunctionReference<
        "query",
        "internal",
        { requestId: string },
        any,
        Name
      >;
      listAdjustments: FunctionReference<
        "query",
        "internal",
        { dimension: string; limit?: number; value: string },
        any,
        Name
      >;
      listBuckets: FunctionReference<
        "query",
        "internal",
        { dimension?: string },
        any,
        Name
      >;
      listPrices: FunctionReference<"query", "internal", {}, any, Name>;
      listRequests: FunctionReference<
        "query",
        "internal",
        { dimension?: string; limit?: number; userId?: string; value?: string },
        any,
        Name
      >;
      setAlertDefaults: FunctionReference<
        "mutation",
        "internal",
        { warnAtPct?: number },
        null,
        Name
      >;
      setBucketLimits: FunctionReference<
        "mutation",
        "internal",
        {
          blocked?: boolean;
          dailySpendLimitNanos?: number;
          dailyTokenLimit?: number;
          dimension: string;
          enforcement?: "hard" | "soft";
          lifetimeSpendLimitNanos?: number;
          lifetimeTokenLimit?: number;
          maxConcurrent?: number;
          monthlySpendLimitNanos?: number;
          monthlyTokenLimit?: number;
          requestsPerMinute?: number;
          value: string;
          warnAtPct?: number;
        },
        null,
        Name
      >;
      setGlobalLimits: FunctionReference<
        "mutation",
        "internal",
        {
          dailySpendLimitNanos?: number;
          enforcement?: "hard" | "soft";
          lifetimeSpendLimitNanos?: number;
        },
        null,
        Name
      >;
      setModelPolicy: FunctionReference<
        "mutation",
        "internal",
        { mode: "open" | "allowlist" | "denylist"; models: Array<string> },
        null,
        Name
      >;
      setPrice: FunctionReference<
        "mutation",
        "internal",
        {
          cachedNanosPerMTok?: number;
          inputNanosPerMTok: number;
          model: string;
          outputNanosPerMTok: number;
        },
        null,
        Name
      >;
      setRetention: FunctionReference<
        "mutation",
        "internal",
        { retentionMs: number },
        null,
        Name
      >;
      startRequest: FunctionReference<
        "mutation",
        "internal",
        {
          actionName?: string;
          messages: Array<{ content: string; role: string }>;
          model: string;
          rerunOf?: string;
          tags?: Array<{ dimension: string; value: string }>;
          userId: string;
        },
        | {
            allowed: true;
            notices: Array<string>;
            requestId: string;
            warnings: Array<string>;
          }
        | { allowed: false; code: string; reason: string },
        Name
      >;
      usageHistory: FunctionReference<
        "query",
        "internal",
        {
          dimension: string;
          limit?: number;
          period: "day" | "month";
          value: string;
        },
        any,
        Name
      >;
    };
  };
