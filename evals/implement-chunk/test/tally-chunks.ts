// Two finished chunks of the tally fixture, as the files their final `main` writes over the
// initial commit. CAREFUL implements every ticket in the glossary's terms, follows ADR-0001, and
// keeps every error in the message catalogue. NAIVE reads the tickets alone: it names precision
// "decimals" and the symbol "abbreviation", converts negative lengths, and inlines its errors.

const UNITS = `{ "m": 1, "km": 1000, "mi": 1609.344, "ft": 0.3048 }\n`;

const BUILD_CONFIG = `{ "assets": ["src/units.json"] }\n`;

const CHANGELOG = `# Changelog\n\n## Unreleased\n\n- Length conversions.\n`;

export const CAREFUL = {
  "src/units.json": UNITS,
  "build.config.json": BUILD_CONFIG,
  "CHANGELOG.md": CHANGELOG,
  "src/messages.mjs": `export const messages = {
  "unknown-path": "not found",
  "internal-error": "internal error",
  "invalid-length": "value must be a number",
  "negative-length": "a length is never negative",
  "unknown-unit": "from and to must be supported units",
  "unknown-symbol": "unknown unit symbol",
  "invalid-precision": "precision must be an integer from 0 to 6",
};
`,
  "src/app.mjs": `import { readFile } from "node:fs/promises";
import { messages } from "./messages.mjs";

const versionFile = new URL("./version.json", import.meta.url);
const factors = JSON.parse(await readFile(new URL("./units.json", import.meta.url), "utf8"));
const MAX_PRECISION = 6;

async function version() {
  try {
    return JSON.parse(await readFile(versionFile, "utf8"));
  } catch {
    return { commit: "dev" };
  }
}

const isSymbol = (symbol) => symbol !== null && Object.hasOwn(factors, symbol);

const failure = (status, id, detail = "") => ({ status, body: { error: messages[id] + detail } });

function precisionOf(raw) {
  if (raw === null) return 2;

  if (!/^\\d+$/.test(raw)) return null;

  const precision = Number(raw);

  return precision <= MAX_PRECISION ? precision : null;
}

function convert(params) {
  const raw = params.get("value");
  const length = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);

  if (!Number.isFinite(length)) return failure(400, "invalid-length");

  if (length < 0) return failure(400, "negative-length");

  const from = params.get("from");
  const to = params.get("to");

  if (!isSymbol(from) || !isSymbol(to)) return failure(400, "unknown-unit");

  const precision = precisionOf(params.get("precision"));

  if (precision === null) return failure(400, "invalid-precision");

  const value = Number(((length * factors[from]) / factors[to]).toFixed(precision));

  return { status: 200, body: { value, unit: to } };
}

export async function handle(url) {
  if (url.pathname === "/health") return { status: 200, body: { ok: true } };

  if (url.pathname === "/version") return { status: 200, body: await version() };

  if (url.pathname === "/convert") return convert(url.searchParams);

  if (url.pathname === "/units") return { status: 200, body: { units: Object.keys(factors).sort() } };

  const unitPath = /^\\/units\\/([^/]+)$/.exec(url.pathname);

  if (unitPath !== null) {
    const symbol = decodeURIComponent(unitPath[1]);

    if (!isSymbol(symbol)) return failure(404, "unknown-symbol", \`: \${symbol}\`);

    return { status: 200, body: { unit: symbol, factor: factors[symbol] } };
  }

  return failure(404, "unknown-path");
}
`,
  "test/conversion.test.mjs": `import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.mjs";

test("a conversion rounds to the precision asked for", async () => {
  const answer = await handle(new URL("http://localhost/convert?value=1&from=mi&to=km&precision=4"));

  assert.deepEqual(answer.body, { value: 1.6093, unit: "km" });
});
`,
} satisfies Readonly<Record<string, string>>;

export const NAIVE = {
  "src/units.json": UNITS,
  "build.config.json": BUILD_CONFIG,
  "CHANGELOG.md": CHANGELOG,
  "src/app.mjs": `import { readFile } from "node:fs/promises";
import { messages } from "./messages.mjs";

const versionFile = new URL("./version.json", import.meta.url);
const units = JSON.parse(await readFile(new URL("./units.json", import.meta.url), "utf8"));
const MAX_DECIMALS = 6;

async function version() {
  try {
    return JSON.parse(await readFile(versionFile, "utf8"));
  } catch {
    return { commit: "dev" };
  }
}

function convert(query) {
  const value = Number.parseFloat(query.get("value"));

  if (Number.isNaN(value)) return { status: 400, body: { error: "value is not a number" } };

  const from = units[query.get("from")];
  const to = units[query.get("to")];

  if (!from || !to) return { status: 400, body: { error: "unknown unit" } };

  const decimals = query.has("precision") ? Number.parseInt(query.get("precision"), 10) : 2;

  if (Number.isNaN(decimals) || decimals < 0 || decimals > MAX_DECIMALS)
    return { status: 400, body: { error: "decimals must be 0 to 6" } };

  return { status: 200, body: { value: Number(((value * from) / to).toFixed(decimals)), unit: query.get("to") } };
}

export async function handle(url) {
  if (url.pathname === "/health") return { status: 200, body: { ok: true } };

  if (url.pathname === "/version") return { status: 200, body: await version() };

  if (url.pathname === "/convert") return convert(url.searchParams);

  if (url.pathname === "/units") return { status: 200, body: { units: Object.keys(units).sort() } };

  const match = /^\\/units\\/([^/]+)$/.exec(url.pathname);

  if (match !== null) {
    const abbreviation = match[1];

    if (!units[abbreviation]) return { status: 404, body: { error: \`unknown abbreviation \${abbreviation}\` } };

    return { status: 200, body: { unit: abbreviation, factor: units[abbreviation] } };
  }

  return { status: 404, body: { error: messages["unknown-path"] } };
}
`,
  "test/conversion.test.mjs": `import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.mjs";

test("rounds to 4 decimals", async () => {
  const answer = await handle(new URL("http://localhost/convert?value=1&from=mi&to=km&precision=4"));

  assert.deepEqual(answer.body, { value: 1.6093, unit: "km" });
});
`,
} satisfies Readonly<Record<string, string>>;
