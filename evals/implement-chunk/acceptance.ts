// The hidden acceptance tests: each ticket's acceptance criteria as HTTP requests against a
// running build. The runner runs them against a fresh build of the final `main` and against the
// live deploy, so `correct` comes from behavior, not from any report.

import { Option, Schema } from "effect";
import { fetchText } from "./deploy.ts";

interface Expectation {
  readonly ticket: string;
  readonly path: string;
  readonly status: number;
  /** What the JSON body must decode as; extra fields are allowed. */
  readonly body: Schema.Decoder<unknown>;
}

const Error400 = Schema.Struct({ error: Schema.NonEmptyString });

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
  { ticket: "TAL-2", path: "/convert?value=10&from=km&to=parsec", status: 400, body: Error400 },
  { ticket: "TAL-2", path: "/convert?value=ten&from=km&to=mi", status: 400, body: Error400 },
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
    body: Error400,
  },
  {
    ticket: "TAL-4",
    path: "/convert?value=1&from=mi&to=km&precision=1.5",
    status: 400,
    body: Error400,
  },
  {
    ticket: "regression",
    path: "/health",
    status: 200,
    body: Schema.Struct({ ok: Schema.Literal(true) }),
  },
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

export function runAcceptance(baseUrl: string): Promise<CheckOutcome[]> {
  return Promise.all(EXPECTATIONS.map((expectation) => check(baseUrl, expectation)));
}
