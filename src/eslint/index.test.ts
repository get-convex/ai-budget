import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import plugin, { noUngovernedAi, DEFAULT_PROVIDERS } from "./index";

// Wire ESLint's RuleTester into vitest's runner.
(RuleTester as unknown as { describe: unknown }).describe = describe;
(RuleTester as unknown as { it: unknown }).it = it;
(RuleTester as unknown as { itOnly: unknown }).itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

ruleTester.run("no-ungoverned-ai", noUngovernedAi, {
  valid: [
    // The budget client itself is fine — that's the governed path.
    { code: `import { Budget } from "@convex-dev/ai-budget";` },
    // Unrelated packages and local imports.
    { code: `import _ from "lodash";` },
    { code: `import { helper } from "./local";` },
    { code: `import { v } from "convex/values";` },
    // A wrapper file allowlisted via a relative glob may touch the raw SDK.
    {
      code: `import OpenAI from "openai";`,
      filename: "/repo/convex/ai.ts",
      options: [{ allow: ["convex/ai.ts"] }],
    },
    // Allowlist via a directory glob.
    {
      code: `import { generateText } from "ai";`,
      filename: "/repo/src/lib/ai/gateway.ts",
      options: [{ allow: ["src/lib/ai/**"] }],
    },
    // Custom provider list can be narrowed so "ai" is no longer flagged.
    {
      code: `import { generateText } from "ai";`,
      options: [{ providers: ["openai"] }],
    },
  ],
  invalid: [
    {
      code: `import OpenAI from "openai";`,
      errors: [{ messageId: "ungoverned", data: { name: "openai" } }],
    },
    {
      code: `import { generateText } from "ai";`,
      errors: [{ messageId: "ungoverned", data: { name: "ai" } }],
    },
    {
      code: `import Anthropic from "@anthropic-ai/sdk";`,
      errors: [{ messageId: "ungoverned" }],
    },
    {
      code: `import { openrouter } from "@openrouter/ai-sdk-provider";`,
      errors: [{ messageId: "ungoverned" }],
    },
    // Direct AI Gateway access bypasses the budget too.
    {
      code: `import { convexGateway } from "@convex-dev/ai-sdk-provider";`,
      errors: [{ messageId: "ungoverned" }],
    },
    // Subpath imports of a flagged package.
    {
      code: `import "openai/resources";`,
      errors: [{ messageId: "ungoverned", data: { name: "openai/resources" } }],
    },
    // Scoped-glob providers.
    {
      code: `import { openai } from "@ai-sdk/openai";`,
      errors: [{ messageId: "ungoverned" }],
    },
    // Dynamic import.
    {
      code: `const m = await import("ai");`,
      errors: [{ messageId: "ungoverned" }],
    },
    // require().
    {
      code: `const OpenAI = require("openai");`,
      languageOptions: { sourceType: "commonjs" },
      errors: [{ messageId: "ungoverned" }],
    },
    // extraProviders adds to the defaults.
    {
      code: `import x from "my-secret-llm";`,
      options: [{ extraProviders: ["my-secret-llm"] }],
      errors: [{ messageId: "ungoverned" }],
    },
    // A file NOT matching the allowlist is still flagged.
    {
      code: `import OpenAI from "openai";`,
      filename: "/repo/convex/other.ts",
      options: [{ allow: ["convex/ai.ts"] }],
      errors: [{ messageId: "ungoverned" }],
    },
  ],
});

// A couple of plain assertions about the exported plugin shape (vitest).
describe("plugin shape", () => {
  it("exposes the rule and a recommended flat config", () => {
    if (!plugin.rules["no-ungoverned-ai"]) throw new Error("rule missing");
    const rec = plugin.configs.recommended;
    if (rec.rules?.["@convex-dev/ai-budget/no-ungoverned-ai"] !== "warn") {
      throw new Error("recommended config should warn by default");
    }
    if (!DEFAULT_PROVIDERS.includes("ai")) throw new Error("defaults missing 'ai'");
  });
});

ruleTester.run("no-ungoverned-ai (re-exports, B5)", noUngovernedAi, {
  valid: [
    { code: `export { helper } from "./local";` },
    { code: `export * from "./util";` },
    { code: `export const x = 1;` },
  ],
  invalid: [
    {
      code: `export { openai } from "openai";`,
      errors: [{ messageId: "ungoverned", data: { name: "openai" } }],
    },
    {
      code: `export * from "ai";`,
      errors: [{ messageId: "ungoverned", data: { name: "ai" } }],
    },
  ],
});
