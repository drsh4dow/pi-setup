import { effectNative, strict as effectStrict } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

// Reference checkouts, runtime state, installed skills, and vendored lint rules
// are not application source. The maintained babysit-pr scripts remain checked.
const ignoredFiles = [
  ".repos/**",
  ".firecrawl/**",
  "agent/npm/**",
  "agent/sessions/**",
  "agent/skills/*",
  "!agent/skills/babysit-pr/",
  "tools/oxlint/anti-slop/**",
];

export default defineConfig({
  fmt: { ignorePatterns: ignoredFiles },
  lint: {
    ignorePatterns: ignoredFiles,
    plugins: ["typescript", "import", "unicorn", "oxc", "effecttsgo"],
    categories: { correctness: "error", suspicious: "error", perf: "error" },
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
    ],
    rules: {
      ...effectNative.rules,
      ...effectStrict.rules,
      "effecttsgo/any-unknown-in-error-context": "error",
      "effecttsgo/unsafe-effect-type-assertion": "error",
      "effecttsgo/deterministic-keys": "error",
      "effecttsgo/missing-effect-service-dependency": "error",
      "effecttsgo/global-error-in-effect-failure": "error",
      "effecttsgo/effect-do-notation": "error",
      "effecttsgo/missed-pipeable-opportunity": "error",
      "effecttsgo/nested-effect-gen-yield": "error",
      "effecttsgo/service-not-as-class": "error",
      "effecttsgo/schema-union-of-literals": "error",
      "effecttsgo/unnecessary-arrow-block": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
      "max-lines": ["error", { max: 600 }],
      "prefer-const": "error",
      "no-nested-ternary": "error",
      "no-multi-assign": "error",
      "no-return-assign": ["error", "always"],
      "unicorn/error-message": "error",
      "unicorn/no-unreadable-array-destructuring": "error",
      "no-underscore-dangle": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-floating-promises": [
        "error",
        {
          // node:test owns the completion and failure of registered tests.
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "it", "describe"] },
          ],
        },
      ],
      "typescript/no-misused-promises": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/consistent-type-exports": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "import/no-duplicates": "error",
      "import/no-unassigned-import": "error",
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      "anti-slop-effect/prefer-effect-match": "error",
    },
    overrides: [
      {
        // These are native process, test-runner, or Cloudflare entry points.
        // Effect safety rules still apply wherever they actually use Effect.
        files: [
          "**/test/**",
          "agent/scripts/**",
          "agent/skills/babysit-pr/**",
          "agent/extensions/background-terminals/bin/**",
          "cli/dumpfile/**",
          "vite.config.ts",
        ],
        rules: {
          "effecttsgo/async-function": "off",
          "effecttsgo/node-builtin-import": "off",
          "effecttsgo/extends-native-error": "off",
          "effecttsgo/global-console": "off",
          "effecttsgo/global-date": "off",
          "effecttsgo/global-fetch": "off",
          "effecttsgo/global-random": "off",
          "effecttsgo/global-timers": "off",
          "effecttsgo/crypto-random-uuid": "off",
          "effecttsgo/process-env": "off",
          "effecttsgo/new-promise": "off",
          "effecttsgo/schema-sync": "off",
        },
      },
      {
        // Tests and extension entry points assemble their own service layers.
        files: [
          "**/test/**",
          "agent/extensions/*/index.ts",
          "agent/extensions/herdr-agent-state.ts",
        ],
        rules: { "effecttsgo/strict-effect-provide": "off" },
      },
      {
        // Process APIs remain unstable; Effect is pinned exactly.
        files: ["agent/extensions/test/tmux.ts", "agent/extensions/test/process.ts"],
        rules: { "effecttsgo/unstable-api-usage": "off" },
      },
    ],
  },
});
