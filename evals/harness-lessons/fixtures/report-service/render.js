import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEMPLATES = new URL("./templates/", import.meta.url);

export function fill(template, values) {
  return template.replaceAll(/{{(\w+)}}/g, (_, key) => String(values[key] ?? ""));
}

export function loadTemplates() {
  return Object.fromEntries(
    readdirSync(TEMPLATES)
      .filter((name) => name.endsWith(".md"))
      .map((name) => [name.replace(/\.md$/, ""), readFileSync(new URL(name, TEMPLATES), "utf8")]),
  );
}

export function renderAccount(templates, account) {
  return [templates.header, templates.summary, templates.detail]
    .map((template) => fill(template, account))
    .join("\n");
}

if (import.meta.main) {
  const [accountsFile, outDir] = process.argv.slice(2);
  const accounts = JSON.parse(readFileSync(accountsFile, "utf8"));
  const templates = loadTemplates();

  mkdirSync(outDir, { recursive: true });

  for (const account of accounts) {
    writeFileSync(join(outDir, `${account.id}.md`), renderAccount(templates, account));
  }
}
