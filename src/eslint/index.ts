/**
 * ESLint plugin for `@convex-dev/ai-budget`.
 *
 * Rule `no-ungoverned-ai` warns when a file imports an AI provider SDK, the AI
 * SDK, OpenRouter, or the Convex AI Gateway provider *directly* — because doing
 * so lets you spend AI money without it flowing through the budget (no spend
 * tracking, no caps, no attribution).
 *
 * The budget deliberately can't own the provider call: the real call lives
 * inside a budget callback, e.g. `ai.meter(ctx, …, async () => openai.…)`. So the
 * enforcement is an *import boundary*: confine provider imports to your budget
 * wrapper module and add that module to the rule's `allow` option (or turn the
 * rule off for it with a flat-config `files` override). Everywhere else, a
 * provider import is a bypass and gets flagged.
 *
 * Flat-config usage:
 *
 *   import aiBudget from "@convex-dev/ai-budget/eslint";
 *   export default [
 *     aiBudget.configs.recommended,
 *     // your budget wrapper is allowed to touch the raw SDKs:
 *     { files: ["convex/ai.ts"],
 *       rules: { "@convex-dev/ai-budget/no-ungoverned-ai": "off" } },
 *   ];
 *
 * or, equivalently, via the rule's own `allow` option:
 *
 *   { plugins: { "@convex-dev/ai-budget": aiBudget },
 *     rules: { "@convex-dev/ai-budget/no-ungoverned-ai":
 *       ["warn", { allow: ["convex/ai.ts"] }] } }
 */
import type { Rule } from "eslint";
import type { Node } from "estree";

const PLUGIN_NAME = "@convex-dev/ai-budget";

/**
 * Modules that spend AI money outside the budget: raw provider SDKs, the AI SDK,
 * OpenRouter, and the Convex AI Gateway provider. Each entry matches the module
 * itself *and* any subpath (`"openai"` → `"openai/resources"`); a trailing `/*`
 * matches everything under a scope or namespace (`"@ai-sdk/*"` → `"@ai-sdk/openai"`).
 */
const DEFAULT_PROVIDERS: readonly string[] = [
  "ai", // Vercel AI SDK (generateText/streamText/…)
  "@ai-sdk/*", // AI SDK provider packages
  "openai", // OpenAI SDK
  "@anthropic-ai/sdk", // Anthropic SDK
  "@anthropic-ai/*",
  "openrouter", // OpenRouter
  "@openrouter/*",
  "@convex-dev/ai-sdk-provider", // Convex AI Gateway provider — direct gateway access
  "cohere-ai",
  "@google/generative-ai",
  "@mistralai/mistralai",
  "@mistralai/*",
  "groq-sdk",
  "replicate",
  "@fal-ai/*",
  "together-ai",
];

/** Compile a glob (supporting `*`, `**`, `?`) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"; // ** — any characters, including path separators
        i++;
        if (glob[i + 1] === "/") i++; // swallow the slash so `**/x` matches `x`
      } else {
        re += "[^/]*"; // * — anything but a path separator
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

/** Match an import source against the provider patterns (exact, subpath, or `/*`). */
function makeSourceMatcher(
  patterns: readonly string[],
): (source: string) => boolean {
  const compiled = patterns.map((p) => {
    if (p.endsWith("/*")) {
      const prefix = p.slice(0, -1); // "@ai-sdk/*" -> "@ai-sdk/"
      return (s: string) => s.startsWith(prefix);
    }
    if (p.includes("*")) {
      const re = globToRegExp(p);
      return (s: string) => re.test(s);
    }
    return (s: string) => s === p || s.startsWith(p + "/");
  });
  return (source) => compiled.some((fn) => fn(source));
}

/** Match a filename against `allow` globs; relative patterns match anywhere in the path. */
function makeFileMatcher(
  patterns: readonly string[],
): (file: string) => boolean {
  if (patterns.length === 0) return () => false;
  const res = patterns.map((p) => {
    const norm = p.replace(/\\/g, "/");
    const anchored =
      norm.startsWith("/") || norm.startsWith("**") ? norm : "**/" + norm;
    return globToRegExp(anchored);
  });
  return (file) => {
    const f = file.replace(/\\/g, "/");
    return res.some((r) => r.test(f));
  };
}

type Options = {
  /** Replace the default provider list entirely. */
  providers?: string[];
  /** Add to the default provider list (keeps the defaults). */
  extraProviders?: string[];
  /** Glob patterns of files permitted to import providers (your budget wrapper). */
  allow?: string[];
};

const noUngovernedAi: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing AI provider SDKs or the AI Gateway outside the budget wrapper, so all AI spend flows through @convex-dev/ai-budget.",
      recommended: true,
      url: "https://github.com/get-convex/ai-budget#no-ungoverned-ai",
    },
    schema: [
      {
        type: "object",
        properties: {
          providers: { type: "array", items: { type: "string" } },
          extraProviders: { type: "array", items: { type: "string" } },
          allow: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      ungoverned:
        "Importing '{{name}}' calls AI providers outside the budget, so this spend isn't tracked or capped. Route it through the budget client (ai.meter / ai.chat / ai.decisions). If this is your budget wrapper module, add it to this rule's `allow` option or turn the rule off for it.",
    },
  },
  create(context) {
    const opts: Options = context.options[0] ?? {};
    const patterns = [
      ...(opts.providers ?? DEFAULT_PROVIDERS),
      ...(opts.extraProviders ?? []),
    ];
    const matchesSource = makeSourceMatcher(patterns);
    const isAllowedFile = makeFileMatcher(opts.allow ?? []);

    const filename =
      context.filename ??
      (context as unknown as { getFilename(): string }).getFilename();
    if (isAllowedFile(filename)) return {};

    function check(sourceNode: Node | null | undefined, reportNode: Node) {
      if (!sourceNode || sourceNode.type !== "Literal") return;
      const value = (sourceNode as { value?: unknown }).value;
      if (typeof value !== "string") return;
      if (matchesSource(value)) {
        context.report({
          node: reportNode,
          messageId: "ungoverned",
          data: { name: value },
        });
      }
    }

    // A type-only import/export (`import type …`, `export type … from`) is erased
    // at compile time and makes no runtime provider call, so it's not a bypass.
    const isTypeOnly = (node: { importKind?: string; exportKind?: string }) =>
      node.importKind === "type" || node.exportKind === "type";

    return {
      ImportDeclaration(node) {
        if (isTypeOnly(node as any)) return;
        check(node.source, node);
      },
      // dynamic import("...")
      ImportExpression(node) {
        check((node as unknown as { source: Node }).source, node);
      },
      // re-exports: `export { x } from "openai"`, `export * from "ai"`
      ExportNamedDeclaration(node) {
        if (isTypeOnly(node as any)) return;
        check((node as unknown as { source?: Node | null }).source, node);
      },
      ExportAllDeclaration(node) {
        if (isTypeOnly(node as any)) return;
        check((node as unknown as { source?: Node | null }).source, node);
      },
      // require("...")
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "Identifier" &&
          callee.name === "require" &&
          node.arguments.length === 1
        ) {
          check(node.arguments[0] as Node, node);
        }
      },
    };
  },
};

type FlatConfig = {
  name?: string;
  plugins?: Record<string, unknown>;
  rules?: Record<string, unknown>;
};

const plugin: {
  meta: { name: string };
  rules: Record<string, Rule.RuleModule>;
  configs: Record<string, FlatConfig>;
} = {
  meta: { name: PLUGIN_NAME },
  rules: { "no-ungoverned-ai": noUngovernedAi },
  configs: {},
};

// Flat recommended config — references the plugin object above.
plugin.configs.recommended = {
  name: "@convex-dev/ai-budget/recommended",
  plugins: { "@convex-dev/ai-budget": plugin },
  rules: { "@convex-dev/ai-budget/no-ungoverned-ai": "warn" },
};

export { noUngovernedAi, DEFAULT_PROVIDERS };
export default plugin;
