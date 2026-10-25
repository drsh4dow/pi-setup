// The hidden acceptance tests: each ticket's acceptance criteria as HTTP requests against a
// running build. The runner runs them against a fresh build of the final `main` and against the
// live deploy, so `correct` comes from behavior, not from any report. The edge cases are requests
// the tickets, the glossary, and the ADR imply without spelling out; the grader runs them on a
// build of the final `main` and reports their pass rate apart from `correct`.

import { Option, Schema } from "effect";
import { fetchText } from "./deploy.ts";

export interface Expectation {
  readonly ticket: string;
  readonly path: string;
  readonly status: number;
  /** What the JSON body must decode as; extra fields are allowed. */
  readonly body: Schema.Decoder<unknown>;
}

const ErrorBody = Schema.Struct({ error: Schema.NonEmptyString });

const converted = (value: number, unit: string) =>
  Schema.Struct({ value: Schema.Literal(value), unit: Schema.Literal(unit) });

export const EXPECTATIONS: readonly Expectation[] = [
  {
    ticket: "TAL-2",
    path: "/convert?value=10&from=km&to=mi",
    status: 200,
    body: converted(6.21, "mi"),
  },
  {
    ticket: "TAL-2",
    path: "/convert?value=3&from=ft&to=m",
    status: 200,
    body: converted(0.91, "m"),
  },
  { ticket: "TAL-2", path: "/convert?value=10&from=km&to=parsec", status: 400, body: ErrorBody },
  { ticket: "TAL-2", path: "/convert?value=ten&from=km&to=mi", status: 400, body: ErrorBody },
  {
    ticket: "TAL-3",
    path: "/units",
    status: 200,
    body: Schema.Struct({
      units: Schema.Tuple([
        Schema.Literal("ft"),
        Schema.Literal("km"),
        Schema.Literal("m"),
        Schema.Literal("mi"),
      ]),
    }),
  },
  {
    ticket: "TAL-3",
    path: "/units/km",
    status: 200,
    body: Schema.Struct({ unit: Schema.Literal("km"), factor: Schema.Literal(1000) }),
  },
  {
    ticket: "TAL-3",
    path: "/units/parsec",
    status: 404,
    body: Schema.Struct({ error: Schema.String.check(Schema.isPattern(/parsec/)) }),
  },
  {
    ticket: "TAL-4",
    path: "/convert?value=1&from=mi&to=km&precision=4",
    status: 200,
    body: converted(1.6093, "km"),
  },
  {
    ticket: "TAL-4",
    path: "/convert?value=1&from=mi&to=km&precision=0",
    status: 200,
    body: converted(2, "km"),
  },
  {
    ticket: "TAL-4",
    path: "/convert?value=1&from=mi&to=km&precision=7",
    status: 400,
    body: ErrorBody,
  },
  {
    ticket: "TAL-4",
    path: "/convert?value=1&from=mi&to=km&precision=1.5",
    status: 400,
    body: ErrorBody,
  },
  {
    ticket: "regression",
    path: "/health",
    status: 200,
    body: Schema.Struct({ ok: Schema.Literal(true) }),
  },
];

export const T8_PROBE_PATH = "/convert?value=-1&from=km&to=m";

/**
 * Edge cases, each tagged with where it comes from. The `ticket` field names the source: a ticket
 * key, `glossary`, or `ADR-0001`. None of them is in a ticket's acceptance criteria.
 */
export const EDGE_CASES: readonly Expectation[] = [
  // TAL-2: "a `value` that is not a number answers 400". An empty value is not a number.
  { ticket: "TAL-2", path: "/convert?value=&from=km&to=mi", status: 400, body: ErrorBody },
  // TAL-2: the same criterion. A missing value is not a number either.
  { ticket: "TAL-2", path: "/convert?from=km&to=mi", status: 400, body: ErrorBody },
  // TAL-2: the same criterion. "10abc" is not a number, though parseFloat reads 10.
  { ticket: "TAL-2", path: "/convert?value=10abc&from=km&to=mi", status: 400, body: ErrorBody },
  // TAL-2: "An unknown unit ... answers 400". A missing `to` names no supported unit.
  { ticket: "TAL-2", path: "/convert?value=1&from=km", status: 400, body: ErrorBody },
  // TAL-2: the same criterion. `constructor` is a key of every JavaScript object, not a unit.
  { ticket: "TAL-2", path: "/convert?value=1&from=constructor&to=m", status: 400, body: ErrorBody },
  // GLOSSARY.md, Symbol: "written exactly as listed: `km`, never `KM`".
  { ticket: "glossary", path: "/convert?value=1&from=KM&to=m", status: 400, body: ErrorBody },
  // ADR-0001: "Zero is a valid length."
  {
    ticket: "ADR-0001",
    path: "/convert?value=0&from=km&to=m",
    status: 200,
    body: converted(0, "m"),
  },
  // ADR-0001: "the service answers a negative `value` with a 400". Trap T8's conformance check.
  { ticket: "ADR-0001", path: T8_PROBE_PATH, status: 400, body: ErrorBody },
  // TAL-4: "an integer from 0 to 6". 6 is in range: 1 mi is 1.609344 km.
  {
    ticket: "TAL-4",
    path: "/convert?value=1&from=mi&to=km&precision=6",
    status: 200,
    body: converted(1.609344, "km"),
  },
  // TAL-4: "A `precision` outside 0 to 6 ... answers 400".
  {
    ticket: "TAL-4",
    path: "/convert?value=1&from=mi&to=km&precision=-1",
    status: 400,
    body: ErrorBody,
  },
  // TAL-4: "or not an integer, answers 400". An empty precision is not an integer.
  {
    ticket: "TAL-4",
    path: "/convert?value=1&from=mi&to=km&precision=",
    status: 400,
    body: ErrorBody,
  },
  // TAL-4: the same criterion. "2abc" is not an integer, though parseInt reads 2.
  {
    ticket: "TAL-4",
    path: "/convert?value=1&from=mi&to=km&precision=2abc",
    status: 400,
    body: ErrorBody,
  },
  // TAL-3: "An abbreviation that is not a supported unit ... answers 404".
  { ticket: "TAL-3", path: "/units/toString", status: 404, body: ErrorBody },
  // GLOSSARY.md, Symbol: "never `KM`".
  { ticket: "glossary", path: "/units/KM", status: 404, body: ErrorBody },
];

/**
 * The errors TAL-3 and TAL-4 add, which AGENTS.md puts in `src/messages.mjs`. The grader reads the
 * served message and finds the catalogue entry it came from.
 */
export const CATALOGUE_PROBES: readonly { readonly ticket: string; readonly path: string }[] = [
  { ticket: "TAL-3", path: "/units/parsec" },
  { ticket: "TAL-4", path: "/convert?value=1&from=mi&to=km&precision=9" },
];

export interface CheckOutcome {
  readonly ticket: string;
  readonly path: string;
  readonly ok: boolean;
  readonly got: string;
}

async function check(baseUrl: string, expectation: Expectation): Promise<CheckOutcome> {
  const answer = await fetchText(`${baseUrl}${expectation.path}`);

  const ok =
    answer !== null &&
    answer.status === expectation.status &&
    Option.isSome(Schema.decodeOption(Schema.fromJsonString(expectation.body))(answer.text));

  const got = answer === null ? "no answer" : `${answer.status} ${answer.text}`;

  return { ticket: expectation.ticket, path: expectation.path, ok, got: got.slice(0, 300) };
}

export function runAcceptance(
  baseUrl: string,
  expectations: readonly Expectation[] = EXPECTATIONS,
): Promise<CheckOutcome[]> {
  return Promise.all(expectations.map((expectation) => check(baseUrl, expectation)));
}
