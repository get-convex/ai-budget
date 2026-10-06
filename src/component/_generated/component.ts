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
          actorId?: string;
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
          actorId?: string;
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
        {
          actorId?: string;
          dailyNanos?: number;
          lifetimeNanos?: number;
          monthlyNanos?: number;
        },
        null,
        Name
      >;
      deleteBucket: FunctionReference<
        "mutation",
        "internal",
        { actorId?: string; dimension: string; value: string },
        { deletedThisBatch: number; done: boolean },
        Name
      >;
      finishRequest: FunctionReference<
        "mutation",
        "internal",
        {
          cachedTokens?: number;
          cachedWrite1hTokens?: number;
          cachedWriteTokens?: number;
          completionTokens?: number;
          costNanos?: number;
          error?: string;
          latencyMs?: number;
          promptTokens?: number;
          requestId: string;
          responseText?: string;
          serverToolUses?: Record<string, number>;
        },
        { costNanos: number },
        Name
      >;
      getBillingEvent: FunctionReference<
        "query",
        "internal",
        { requestId: string },
        {
          _creationTime: number;
          _id: string;
          bucketIds: Array<string>;
          costNanos: number;
          costSource?:
            "authoritative" | "token_estimate" | "reservation_estimate";
          finishedAt: number;
          requestId: string;
          tokens: number;
        } | null,
        Name
      >;
      getBucket: FunctionReference<
        "query",
        "internal",
        { dimension: string; value: string },
        {
          _creationTime: number;
          _id: string;
          blocked?: boolean;
          bumpDayStamp?: string;
          bumpMonthStamp?: string;
          creditsNanos?: number;
          creditsThisMonthNanos?: number;
          creditsTodayNanos?: number;
          dailyBumpNanos?: number;
          dailySpendLimitNanos?: number;
          dailyTokenLimit?: number;
          dayStamp: string;
          dimension: string;
          enforcement?: "hard" | "soft";
          lifetimeBumpNanos?: number;
          lifetimeSpendLimitNanos?: number;
          lifetimeTokenLimit?: number;
          maxConcurrent?: number;
          monthStamp?: string;
          monthlyBumpNanos?: number;
          monthlySpendLimitNanos?: number;
          monthlyTokenLimit?: number;
          pendingCount?: number;
          requestsPerMinute?: number;
          reservedMonthNanos?: number;
          reservedMonthTokens?: number;
          reservedTodayNanos?: number;
          reservedTodayTokens?: number;
          reservedTotalNanos?: number;
          reservedTotalTokens?: number;
          spendThisMonthNanos: number;
          spendTodayNanos: number;
          tokensThisMonth: number;
          tokensToday: number;
          totalRequests: number;
          totalSpendNanos: number;
          totalTokens: number;
          value: string;
          warnAtPct?: number;
        } | null,
        Name
      >;
      getGlobalStatus: FunctionReference<
        "query",
        "internal",
        {},
        {
          dailySpendLimitNanos: number | null;
          defaultWarnAtPct: number | null;
          enforcement: "approximate" | "hard" | "soft";
          lifetimeSpendLimitNanos: number | null;
          retentionMs: number | null;
          spentTodayNanos: number;
          spentTotalNanos: number;
        },
        Name
      >;
      getHealth: FunctionReference<
        "query",
        "internal",
        {},
        {
          countsTruncated: boolean;
          globalCheckedAt: number | null;
          oldestDeltaAt: number | null;
          oldestUnfoldedAt: number | null;
          pendingDeltas: number;
          pendingFolds: number;
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
        {
          _creationTime: number;
          _id: string;
          actionName?: string;
          attributedBuckets?: Array<{
            bucketId: string;
            dimension: string;
            value: string;
          }>;
          cachedTokens?: number;
          cachedWrite1hTokens?: number;
          cachedWriteTokens?: number;
          completionTokens?: number;
          contentPurged?: boolean;
          costNanos?: number;
          costSource?:
            "authoritative" | "token_estimate" | "reservation_estimate";
          error?: string;
          estimatedNanos?: number;
          estimatedTokens?: number;
          expiredAt?: number;
          expiresAt?: number;
          finishedAt?: number;
          heldBucketIds?: Array<string>;
          latencyMs?: number;
          messages: Array<{ content: string; role: string }>;
          model: string;
          overBudget?: boolean;
          priceSnapshot?: {
            cacheWrite: number;
            cacheWrite1h?: number;
            cached: number;
            input: number;
            output: number;
          };
          privacyErased?: boolean;
          promptTokens?: number;
          rerunOf?: string;
          reservationDay?: string;
          reservationExpired?: boolean;
          reservationMonth?: string;
          reservationReleased?: boolean;
          reserveTtlMs?: number;
          responseText?: string;
          serverToolPriceSnapshot?: Record<string, number>;
          serverToolUses?: Record<string, number>;
          settled?: boolean;
          status: "pending" | "success" | "error" | "blocked";
          tags?: Array<{ dimension: string; value: string }>;
          unpricedModel?: boolean;
          userId: string;
        } | null,
        Name
      >;
      lineage: FunctionReference<
        "query",
        "internal",
        { requestId: string },
        {
          ancestors: Array<{
            _creationTime: number;
            _id: string;
            actionName?: string;
            attributedBuckets?: Array<{
              bucketId: string;
              dimension: string;
              value: string;
            }>;
            cachedTokens?: number;
            cachedWrite1hTokens?: number;
            cachedWriteTokens?: number;
            completionTokens?: number;
            contentPurged?: boolean;
            costNanos?: number;
            costSource?:
              "authoritative" | "token_estimate" | "reservation_estimate";
            error?: string;
            estimatedNanos?: number;
            estimatedTokens?: number;
            expiredAt?: number;
            expiresAt?: number;
            finishedAt?: number;
            heldBucketIds?: Array<string>;
            latencyMs?: number;
            messages: Array<{ content: string; role: string }>;
            model: string;
            overBudget?: boolean;
            priceSnapshot?: {
              cacheWrite: number;
              cacheWrite1h?: number;
              cached: number;
              input: number;
              output: number;
            };
            privacyErased?: boolean;
            promptTokens?: number;
            rerunOf?: string;
            reservationDay?: string;
            reservationExpired?: boolean;
            reservationMonth?: string;
            reservationReleased?: boolean;
            reserveTtlMs?: number;
            responseText?: string;
            serverToolPriceSnapshot?: Record<string, number>;
            serverToolUses?: Record<string, number>;
            settled?: boolean;
            status: "pending" | "success" | "error" | "blocked";
            tags?: Array<{ dimension: string; value: string }>;
            unpricedModel?: boolean;
            userId: string;
          }>;
          reruns: Array<{
            _creationTime: number;
            _id: string;
            actionName?: string;
            attributedBuckets?: Array<{
              bucketId: string;
              dimension: string;
              value: string;
            }>;
            cachedTokens?: number;
            cachedWrite1hTokens?: number;
            cachedWriteTokens?: number;
            completionTokens?: number;
            contentPurged?: boolean;
            costNanos?: number;
            costSource?:
              "authoritative" | "token_estimate" | "reservation_estimate";
            error?: string;
            estimatedNanos?: number;
            estimatedTokens?: number;
            expiredAt?: number;
            expiresAt?: number;
            finishedAt?: number;
            heldBucketIds?: Array<string>;
            latencyMs?: number;
            messages: Array<{ content: string; role: string }>;
            model: string;
            overBudget?: boolean;
            priceSnapshot?: {
              cacheWrite: number;
              cacheWrite1h?: number;
              cached: number;
              input: number;
              output: number;
            };
            privacyErased?: boolean;
            promptTokens?: number;
            rerunOf?: string;
            reservationDay?: string;
            reservationExpired?: boolean;
            reservationMonth?: string;
            reservationReleased?: boolean;
            reserveTtlMs?: number;
            responseText?: string;
            serverToolPriceSnapshot?: Record<string, number>;
            serverToolUses?: Record<string, number>;
            settled?: boolean;
            status: "pending" | "success" | "error" | "blocked";
            tags?: Array<{ dimension: string; value: string }>;
            unpricedModel?: boolean;
            userId: string;
          }>;
          truncated: boolean;
        },
        Name
      >;
      listAdjustments: FunctionReference<
        "query",
        "internal",
        { dimension: string; limit?: number; value: string },
        Array<{
          _creationTime: number;
          _id: string;
          deltaNanos: number;
          dimension: string;
          reason?: string;
          tokens?: number;
          value: string;
        }>,
        Name
      >;
      listBuckets: FunctionReference<
        "query",
        "internal",
        { dimension?: string },
        Array<{
          _creationTime: number;
          _id: string;
          blocked?: boolean;
          bumpDayStamp?: string;
          bumpMonthStamp?: string;
          creditsNanos?: number;
          creditsThisMonthNanos?: number;
          creditsTodayNanos?: number;
          dailyBumpNanos?: number;
          dailySpendLimitNanos?: number;
          dailyTokenLimit?: number;
          dayStamp: string;
          dimension: string;
          enforcement?: "hard" | "soft";
          lifetimeBumpNanos?: number;
          lifetimeSpendLimitNanos?: number;
          lifetimeTokenLimit?: number;
          maxConcurrent?: number;
          monthStamp?: string;
          monthlyBumpNanos?: number;
          monthlySpendLimitNanos?: number;
          monthlyTokenLimit?: number;
          pendingCount?: number;
          requestsPerMinute?: number;
          reservedMonthNanos?: number;
          reservedMonthTokens?: number;
          reservedTodayNanos?: number;
          reservedTodayTokens?: number;
          reservedTotalNanos?: number;
          reservedTotalTokens?: number;
          spendThisMonthNanos: number;
          spendTodayNanos: number;
          tokensThisMonth: number;
          tokensToday: number;
          totalRequests: number;
          totalSpendNanos: number;
          totalTokens: number;
          value: string;
          warnAtPct?: number;
        }>,
        Name
      >;
      listPrices: FunctionReference<
        "query",
        "internal",
        {},
        Record<
          string,
          {
            cacheWrite?: number;
            cacheWrite1h?: number;
            cached?: number;
            input: number;
            output: number;
            overridden: boolean;
          }
        >,
        Name
      >;
      listRequests: FunctionReference<
        "query",
        "internal",
        { dimension?: string; limit?: number; userId?: string; value?: string },
        Array<{
          _creationTime: number;
          _id: string;
          actionName?: string;
          attributedBuckets?: Array<{
            bucketId: string;
            dimension: string;
            value: string;
          }>;
          cachedTokens?: number;
          cachedWrite1hTokens?: number;
          cachedWriteTokens?: number;
          completionTokens?: number;
          contentPurged?: boolean;
          costNanos?: number;
          costSource?:
            "authoritative" | "token_estimate" | "reservation_estimate";
          error?: string;
          estimatedNanos?: number;
          estimatedTokens?: number;
          expiredAt?: number;
          expiresAt?: number;
          finishedAt?: number;
          heldBucketIds?: Array<string>;
          latencyMs?: number;
          messages: Array<{ content: string; role: string }>;
          model: string;
          overBudget?: boolean;
          priceSnapshot?: {
            cacheWrite: number;
            cacheWrite1h?: number;
            cached: number;
            input: number;
            output: number;
          };
          privacyErased?: boolean;
          promptTokens?: number;
          rerunOf?: string;
          reservationDay?: string;
          reservationExpired?: boolean;
          reservationMonth?: string;
          reservationReleased?: boolean;
          reserveTtlMs?: number;
          serverToolPriceSnapshot?: Record<string, number>;
          serverToolUses?: Record<string, number>;
          settled?: boolean;
          status: "pending" | "success" | "error" | "blocked";
          tags?: Array<{ dimension: string; value: string }>;
          unpricedModel?: boolean;
          userId: string;
        }>,
        Name
      >;
      listServerToolPrices: FunctionReference<
        "query",
        "internal",
        {},
        Record<string, number>,
        Name
      >;
      paginateAdminEvents: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            actorId: string;
            detailsJson: string;
            dimension?: string;
            operation: string;
            value?: string;
          }>;
        },
        Name
      >;
      paginateBuckets: FunctionReference<
        "query",
        "internal",
        {
          dimension?: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            blocked?: boolean;
            bumpDayStamp?: string;
            bumpMonthStamp?: string;
            creditsNanos?: number;
            creditsThisMonthNanos?: number;
            creditsTodayNanos?: number;
            dailyBumpNanos?: number;
            dailySpendLimitNanos?: number;
            dailyTokenLimit?: number;
            dayStamp: string;
            dimension: string;
            enforcement?: "hard" | "soft";
            lifetimeBumpNanos?: number;
            lifetimeSpendLimitNanos?: number;
            lifetimeTokenLimit?: number;
            maxConcurrent?: number;
            monthStamp?: string;
            monthlyBumpNanos?: number;
            monthlySpendLimitNanos?: number;
            monthlyTokenLimit?: number;
            pendingCount?: number;
            requestsPerMinute?: number;
            reservedMonthNanos?: number;
            reservedMonthTokens?: number;
            reservedTodayNanos?: number;
            reservedTodayTokens?: number;
            reservedTotalNanos?: number;
            reservedTotalTokens?: number;
            spendThisMonthNanos?: number;
            spendTodayNanos: number;
            tokensThisMonth?: number;
            tokensToday?: number;
            totalRequests: number;
            totalSpendNanos: number;
            totalTokens: number;
            value: string;
            warnAtPct?: number;
          }>;
        },
        Name
      >;
      setAlertDefaults: FunctionReference<
        "mutation",
        "internal",
        { actorId?: string; warnAtPct?: number | null },
        null,
        Name
      >;
      setBucketLimits: FunctionReference<
        "mutation",
        "internal",
        {
          actorId?: string;
          blocked?: boolean | null;
          dailySpendLimitNanos?: number | null;
          dailyTokenLimit?: number | null;
          dimension: string;
          enforcement?: "hard" | "soft" | null;
          lifetimeSpendLimitNanos?: number | null;
          lifetimeTokenLimit?: number | null;
          maxConcurrent?: number | null;
          monthlySpendLimitNanos?: number | null;
          monthlyTokenLimit?: number | null;
          requestsPerMinute?: number | null;
          value: string;
          warnAtPct?: number | null;
        },
        null,
        Name
      >;
      setDeploymentPolicy: FunctionReference<
        "mutation",
        "internal",
        {
          actorId?: string;
          allowUnpricedModels?: boolean;
          requireExplicitReservations?: boolean;
          storeContent?: boolean;
          storeRawErrors?: boolean;
        },
        null,
        Name
      >;
      setGlobalLimits: FunctionReference<
        "mutation",
        "internal",
        {
          actorId?: string;
          dailySpendLimitNanos?: number | null;
          enforcement?: "approximate" | "hard" | "soft" | null;
          lifetimeSpendLimitNanos?: number | null;
        },
        null,
        Name
      >;
      setModelPolicy: FunctionReference<
        "mutation",
        "internal",
        {
          actorId?: string;
          mode: "open" | "allowlist" | "denylist";
          models: Array<string>;
        },
        null,
        Name
      >;
      setPrice: FunctionReference<
        "mutation",
        "internal",
        {
          actorId?: string;
          cacheWrite1hNanosPerMTok?: number;
          cacheWriteNanosPerMTok?: number;
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
        { actorId?: string; retentionMs: number },
        null,
        Name
      >;
      setServerToolPrice: FunctionReference<
        "mutation",
        "internal",
        { actorId?: string; nanosPerCall: number; tool: string },
        null,
        Name
      >;
      startRequest: FunctionReference<
        "mutation",
        "internal",
        {
          actionName?: string;
          estimatedCostNanos?: number;
          estimatedTokens?: number;
          idempotencyKey?: string;
          legacyUserId?: string;
          messages: Array<{ content: string; role: string }>;
          model: string;
          rerunOf?: string;
          reserveTtlMs?: number;
          tags?: Array<{ dimension: string; value: string }>;
          userId: string;
        },
        | {
            allowed: true;
            notices: Array<string>;
            requestId: string;
            reused?: boolean;
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
        Array<{
          _creationTime: number;
          _id: string;
          dimension: string;
          period: "day" | "month";
          requests: number;
          spendNanos: number;
          stamp: string;
          tokens: number;
          value: string;
        }>,
        Name
      >;
    };
  };
