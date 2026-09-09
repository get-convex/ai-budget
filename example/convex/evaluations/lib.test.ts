/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob([
  "./**/*.ts",
  "!./**/*.test.ts",
  "!./**/convex.config.ts",
]);

describe("evaluation run lifecycle", () => {
  test("snapshots cases, records results, and completes the run", async () => {
    const t = convexTest(schema, modules);
    const runId = await t.mutation(api.lib.createRun, {
      kind: "backtest",
      configJson: JSON.stringify({ candidate: "Be concise" }),
      budgetTagDimension: "evalRun",
    });
    const caseId = await t.mutation(api.lib.addCase, {
      runId,
      key: "case-1",
      inputJson: JSON.stringify({ prompt: "Hello" }),
      expectedJson: JSON.stringify({ text: "Hi" }),
      sourceId: "agent-thread-1",
    });
    await t.mutation(api.lib.recordResult, {
      runId,
      caseId,
      candidate: "Be concise",
      model: "openai/gpt-4o-mini",
      outputJson: JSON.stringify({ text: "Hello!" }),
      score: 8,
      verdict: "new",
      costNanos: 123,
    });
    await t.mutation(api.lib.completeRun, {
      runId,
      status: "completed",
      summaryJson: JSON.stringify({ improved: 1 }),
    });

    const run = await t.query(api.lib.getRun, { runId });
    const cases = await t.query(api.lib.listCases, { runId });
    const results = await t.query(api.lib.listResults, { runId });
    expect(run?.status).toBe("completed");
    expect(run?.budgetTagDimension).toBe("evalRun");
    expect(cases).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].caseId).toBe(caseId);
    expect(results[0].costNanos).toBe(123);
  });

  test("rejects a result attached to another run's case", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.lib.createRun, {
      kind: "matrix",
      configJson: "{}",
    });
    const second = await t.mutation(api.lib.createRun, {
      kind: "matrix",
      configJson: "{}",
    });
    const caseId = await t.mutation(api.lib.addCase, {
      runId: first,
      key: "case-1",
      inputJson: "{}",
    });
    await expect(
      t.mutation(api.lib.recordResult, {
        runId: second,
        caseId,
        candidate: "candidate",
        costNanos: 0,
      })
    ).rejects.toThrow(/does not belong/);
  });

  test("rejects non-finite query limits", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.lib.listRuns, { limit: Number.NaN })).rejects.toThrow(
      /limit must be finite/
    );
  });
});
