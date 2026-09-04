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
      bumpAction: FunctionReference<
        "mutation",
        "internal",
        { dailyNanos?: number; lifetimeNanos?: number; name: string },
        null,
        Name
      >;
      bumpGlobal: FunctionReference<
        "mutation",
        "internal",
        { dailyNanos?: number; lifetimeNanos?: number },
        null,
        Name
      >;
      bumpUser: FunctionReference<
        "mutation",
        "internal",
        { dailyNanos?: number; lifetimeNanos?: number; userId: string },
        null,
        Name
      >;
      deleteUser: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        { deletedThisBatch: number; done: boolean },
        Name
      >;
      finishRequest: FunctionReference<
        "mutation",
        "internal",
        {
          cachedTokens?: number;
          completionTokens?: number;
          error?: string;
          latencyMs?: number;
          promptTokens?: number;
          requestId: string;
          responseText?: string;
        },
        { costNanos: number },
        Name
      >;
      getGlobalStatus: FunctionReference<
        "query",
        "internal",
        {},
        {
          dailySpendLimitNanos: number | null;
          enforcement: "hard" | "soft";
          lifetimeSpendLimitNanos: number | null;
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
      listActions: FunctionReference<"query", "internal", {}, any, Name>;
      listPrices: FunctionReference<"query", "internal", {}, any, Name>;
      listRequests: FunctionReference<
        "query",
        "internal",
        { limit?: number; userId?: string },
        any,
        Name
      >;
      listUsers: FunctionReference<"query", "internal", {}, any, Name>;
      setActionLimits: FunctionReference<
        "mutation",
        "internal",
        {
          dailySpendLimitNanos?: number;
          dailyTokenLimit?: number;
          disabled?: boolean;
          enforcement?: "hard" | "soft";
          lifetimeSpendLimitNanos?: number;
          lifetimeTokenLimit?: number;
          name: string;
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
      setLimits: FunctionReference<
        "mutation",
        "internal",
        {
          blocked?: boolean;
          dailySpendLimitNanos?: number;
          dailyTokenLimit?: number;
          enforcement?: "hard" | "soft";
          lifetimeSpendLimitNanos?: number;
          lifetimeTokenLimit?: number;
          requestsPerMinute?: number;
          userId: string;
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
          userId: string;
        },
        | { allowed: true; requestId: string; warnings: Array<string> }
        | { allowed: false; code: string; reason: string },
        Name
      >;
    };
  };
