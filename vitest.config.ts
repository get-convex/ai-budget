import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // The package's test suite tests the published component only. The example's
    // Evaluation-component test needs its (gitignored) generated code, so it runs
    // in the example dev context, not here — otherwise `npm test` in a fresh
    // checkout (i.e. release CI) can't resolve its `./_generated` imports.
    include: ["src/**/*.test.ts"],
  },
});
