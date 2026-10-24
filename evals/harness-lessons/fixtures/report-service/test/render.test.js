import assert from "node:assert/strict";
import { test } from "node:test";
import { fill, loadTemplates, renderAccount } from "../render.js";

test("fill replaces every placeholder and blanks unknown ones", () => {
  assert.equal(fill("{{a}} and {{b}}", { a: 1 }), "1 and ");
});

test("a report renders the header, summary, and details in order", () => {
  const report = renderAccount(loadTemplates(), { name: "Acme", orders: 3 });

  assert.ok(report.indexOf("# Weekly report for Acme") < report.indexOf("## Summary"));
  assert.ok(report.indexOf("## Summary") < report.indexOf("## Details"));
});
