import { effectNative, strict as effectStrict } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

import { EVAL_FIXTURE_FOLDERS } from "./scripts/eval-fixture-folders.ts";

// Reference checkouts, runtime state, installed skills, vendored lint rules, and
// eval fixture folders are not application source.
// Declare a new kind of eval fixture folder in scripts/eval-fixture-folders.ts, not here.
const ignoredFiles = [
  ".repos/**",
  "agent/npm/**",
  "agent/playbooks/**",
  "agent/references/**",
  "agent/sessions/**",
  "agent/skills/*",
  ...EVAL_FIXTURE_FOLDERS.map((folder) => `evals/*/${folder}/**`),
  // Real shell scripts the evals run to prepare fixtures, outside the list so verify-docs reads them.
  "evals/*/setup/**",
  // Gitignored eval run output.
  "evals/*/results/**",
  "oxlint/anti-slop/**",
];

// Every task verify runs except the catchup-video renders, which verify adds itself.
const verifyChecks = [
  "verify:strict-diagnostics",
  "verify:skills",
  "verify:terminal-delivery-citations",
  "verify:babysit-scripts",
  "verify:implement-chunk-scripts",
  "verify:subagent-scripts",
  "verify:statechart-scripts",
  "verify:catchup-scripts",
  "test:extensions",
  "test:dumpfile",
  "test:evals",
  "test:docs",
];

export default defineConfig({
  run: {
    // Verify stays quiet on success so agents can read its whole output. Tests use the
    // dot reporter, which still prints each failure in full. Build and deploy progress
    // is dropped, and their errors still reach stderr.
    tasks: {
      "build:cli": {
        command: [
          "vp exec bun build --compile --outfile .build/bin/emit-to-pi agent/extensions/background-terminals/bin/emit-to-pi.ts > /dev/null",
          "vp exec bun build --compile --outfile .build/bin/pi-subagent agent/extensions/subagents/bin/pi-subagent.ts > /dev/null",
          "vp exec bun build --compile --outfile .build/bin/dumpfile cli/dumpfile/src/cli.ts > /dev/null",
        ],
        cache: false,
      },
      "verify:strict-diagnostics": "node scripts/verify-strict-diagnostics.ts",
      // File modes live in the git index, which the cache does not fingerprint, so a
      // replayed pass could hide a script that lost its executable bit.
      "verify:skills": { command: "node scripts/verify-skills.ts", cache: false },
      "verify:terminal-delivery-citations": {
        command: ".agents/skills/verify-terminal-delivery/scripts/check --citations",
        cache: false,
      },
      "verify:babysit-scripts": [
        "cd agent/skills/babysit/scripts && vp exec bun install --frozen-lockfile > /dev/null",
        "tsc --project agent/skills/babysit/scripts/tsconfig.json",
        "cd agent/skills/babysit/scripts && vp exec bun test --only-failures",
      ],
      "verify:implement-chunk-scripts": [
        "tsc --project agent/prompts/implement-chunk/scripts/tsconfig.json",
        "node --test --test-reporter=dot agent/prompts/implement-chunk/scripts/test/*.test.ts",
      ],
      "verify:subagent-scripts": [
        "tsc --project agent/skills/subagents/scripts/tsconfig.json",
        "node --test --test-reporter=dot agent/skills/subagents/scripts/test/*.test.ts",
      ],
      // TLA2TOOLS names a jar that does not exist, so the tests that need TLC skip instead of
      // installing it with mise. Run them by hand as the statechart skill's AGENTS.md says.
      "verify:statechart-scripts": [
        "tsc --project agent/skills/statechart/scripts/tsconfig.json",
        "cd agent/skills/statechart/scripts && TLA2TOOLS=/nonexistent/tla2tools.jar node --test --test-reporter=dot test/statechart.test.ts",
      ],
      // The catchup tests launch Chromium, whose zygote crashes under automatic file
      // tracking, so the cache fingerprints these inputs instead and restores no outputs.
      "verify:catchup-scripts": {
        command: [
          "tsc --project agent/skills/catchup/scripts/tsconfig.json",
          "node --test --test-reporter=dot agent/skills/catchup/scripts/test/*.test.ts",
        ],
        cache: {
          input: [
            "agent/skills/catchup/scripts/**",
            "agent/skills/statechart/scripts/**",
            "bun.lock",
          ],
          output: [],
        },
      },
      // The tests render through Manim, installed on first run into ~/.cache/catchup-video from
      // the uv lockfile, so the cache fingerprints the sources that shape a render.
      "verify:catchup-video-scripts": {
        command: [
          "tsc --project agent/skills/catchup-video/scripts/tsconfig.json",
          "node --test --test-reporter=dot agent/skills/catchup-video/scripts/test/*.test.ts",
        ],
        cache: {
          input: [
            "agent/skills/catchup-video/scripts/**",
            "agent/skills/catchup-video/python/**",
            "agent/skills/catchup-video/fonts/**",
            "agent/skills/catchup-video/example/story.py",
          ],
          output: [],
        },
      },
      "test:extensions": {
        command:
          "node --test --test-reporter=dot $(find agent/extensions -path '*/test/*.test.ts' ! -name 'e2e.test.ts' -print | sort)",
        dependsOn: ["build:cli"],
      },
      "test:dumpfile": {
        command: [
          "bash -n cli/dumpfile/setup.sh cli/dumpfile/bin/dumpfile",
          "node --test --test-reporter=dot cli/dumpfile/test/*.test.ts",
          "WRANGLER_LOG=warn wrangler deploy --dry-run --config cli/dumpfile/wrangler.jsonc",
        ],
        dependsOn: ["build:cli"],
        // The dry run bundles into .wrangler, which would otherwise make every run a cache miss.
        cache: {
          input: [{ auto: true }, "!cli/dumpfile/.wrangler/**"],
          output: [{ auto: true }, "!cli/dumpfile/.wrangler/**"],
        },
      },
      "test:evals": "node --test --test-reporter=dot evals/*/test/*.test.ts",
      "test:docs": [
        "node --test --test-reporter=dot scripts/test/*.test.ts",
        "node scripts/verify-docs.ts",
      ],
      // The dependencies run concurrently; vp check runs once they pass.
      verify: {
        command: "vp check",
        dependsOn: [...verifyChecks, "verify:catchup-video-scripts"],
      },
      // CI runs this, and runs verify:catchup-video-scripts in its own workflow only when the
      // skill changes, because the Manim renders take three minutes.
      "verify:without-video": { command: "vp check", dependsOn: verifyChecks },
    },
  },
  // Pi rewrites agent/settings.json with its own JSON formatting whenever a setting changes.
  fmt: { ignorePatterns: [...ignoredFiles, "agent/settings.json"] },
  lint: {
    ignorePatterns: ignoredFiles,
    plugins: ["typescript", "import", "unicorn", "oxc", "effecttsgo"],
    categories: { correctness: "error", suspicious: "error", perf: "error" },
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./oxlint/anti-slop/index.ts" },
      { name: "anti-slop-effect", specifier: "./oxlint/anti-slop/effect/index.ts" },
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
            { from: "package", package: "node:test", name: ["test", "it", "describe", "suite"] },
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
          "scripts/**",
          "agent/prompts/*/scripts/**",
          "evals/**",
          "agent/extensions/background-terminals/bin/**",
          "agent/extensions/subagents/bin/**",
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
          "agent/extensions/subagents/bin/pi-subagent.ts",
          "agent/extensions/herdr-agent-state.ts",
        ],
        rules: { "effecttsgo/strict-effect-provide": "off" },
      },
    ],
  },
});
