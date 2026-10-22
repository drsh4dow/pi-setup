import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkWorkdir, glossaryTerms } from "../grade.ts";
import { prepareWorkdir } from "../run.ts";
import { scenarios } from "../scenarios.ts";

const storefront = scenarios.find((scenario) => scenario.fixture === "storefront");

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function failed(workdir: string) {
  assert.ok(storefront);

  return checkWorkdir(workdir, storefront)
    .filter((check) => !check.pass)
    .map((check) => check.name);
}

test("glossary terms are the bold lines that end in a colon", () => {
  assert.deepEqual(glossaryTerms("# Shop\n\n**Cart**:\nA basket.\n**SKU**:\nA variant.\n"), [
    "Cart",
    "SKU",
  ]);
});

test("the untouched storefront fixture fails every record check", () => {
  assert.ok(storefront);

  const workdir = prepareWorkdir(storefront);

  try {
    assert.deepEqual(failed(workdir), [
      "edits AGENTS.md, one Agent skills block",
      'folds "## Issue tracker" into the record',
      "issue tracker matches /\\bgh issue\\b/",
      "writes domain docs",
      "records standards and guardrails",
      "seeds a glossary of at least 3 terms found in the code",
    ]);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a complete storefront record passes every check", () => {
  assert.ok(storefront);

  const workdir = prepareWorkdir(storefront);

  try {
    write(workdir, "AGENTS.md", "# Storefront\n\n## Agent skills\n\n- Issue tracker: GitHub.\n");
    write(workdir, "docs/agents/issue-tracker.md", "- **Publish**: `gh issue create`\n");
    write(workdir, "docs/agents/domain.md", "# Domain docs\n");
    write(workdir, "docs/agents/standards.md", "CONTRIBUTING.md\n| lint | typecheck | test |\n");
    write(
      workdir,
      "GLOSSARY.md",
      "**Cart**:\nx\n**Coupon**:\nx\n**Order**:\nx\n**Wishlist**:\nx\n",
    );

    assert.deepEqual(failed(workdir), []);

    write(workdir, "docs/agents/triage-labels.md", "| `ready-for-agent` |\n");

    assert.deepEqual(failed(workdir), ["writes no triage label record"]);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
