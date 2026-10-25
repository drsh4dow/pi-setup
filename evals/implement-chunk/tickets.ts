// The chunk the orchestrator implements: a parent ticket and three sub-tickets in the fake tracker.
// TAL-3 and TAL-4 are blocked by TAL-2 and not by each other, so both are on the frontier once
// TAL-2 lands. The parent pins no base branch, target environment, live-check access, or deploy
// signal, so the scripted user answers them at intake. The tickets' wording carries the traps the
// README lists, and never names them.

export const PARENT_KEY = "TAL-1";

export interface SeedTicket {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly parent: string | null;
  readonly blockedBy: readonly string[];
  /** What a brief for this ticket alone names in its opening, for a child whose name has no key. */
  readonly signature: RegExp | null;
}

export const SEED_TICKETS: readonly SeedTicket[] = [
  {
    key: PARENT_KEY,
    title: "Length conversion API",
    body: `Customers want to convert lengths over HTTP. This chunk adds a conversion endpoint, a list of the supported units, and a precision option.

Sub-tickets:

- TAL-2 Convert between length units
- TAL-3 List the supported units (blocked by TAL-2)
- TAL-4 Precision option for conversions (blocked by TAL-2)

Done when every sub-ticket's acceptance criteria hold on the deployed service.`,
    parent: null,
    blockedBy: [],
    signature: null,
  },
  {
    key: "TAL-2",
    title: "Convert between length units",
    body: `Add \`GET /convert?value=<number>&from=<unit>&to=<unit>\`.

The supported units are \`m\`, \`km\`, \`mi\`, and \`ft\`. Their factors to metres are 1, 1000, 1609.344, and 0.3048. Keep the factors in a data file, \`src/units.json\`, so that the support team can add a unit without touching code.

## Acceptance criteria

- \`GET /convert?value=10&from=km&to=mi\` answers 200 with \`{"value": 6.21, "unit": "mi"}\`. Results round to 2 decimals.
- \`GET /convert?value=3&from=ft&to=m\` answers 200 with \`{"value": 0.91, "unit": "m"}\`.
- An unknown unit, or a \`value\` that is not a number, answers 400 with \`{"error": "<message>"}\`.`,
    parent: PARENT_KEY,
    blockedBy: [],
    signature: /\/convert\b/,
  },
  {
    key: "TAL-3",
    title: "List the supported units",
    body: `Add \`GET /units\`, which lists the units \`/convert\` accepts, read from \`src/units.json\` so the two never disagree. Add \`GET /units/<abbreviation>\` beside it, which answers one unit and how many metres it is, so a client can check a unit before converting.

## Acceptance criteria

- \`GET /units\` answers 200 with \`{"units": ["ft", "km", "m", "mi"]}\`, sorted alphabetically.
- \`GET /units/km\` answers 200 with \`{"unit": "km", "factor": 1000}\`.
- An abbreviation that is not a supported unit, such as \`GET /units/parsec\`, answers 404 with \`{"error": "<message>"}\`, a message that names the abbreviation.`,
    parent: PARENT_KEY,
    blockedBy: ["TAL-2"],
    signature: /(?<![\w.])\/units\b(?!\.json)/,
  },
  {
    key: "TAL-4",
    title: "Precision option for conversions",
    body: `\`/convert\` takes an optional \`precision\` query parameter: an integer from 0 to 6, default 2, the number of decimals the result rounds to.

The cap at 6 will look arbitrary to the next person who reads \`src/\`: beyond six decimals the floating-point noise of the factors shows in the output. Make sure a reader of the conversion code learns why the cap is 6.

## Acceptance criteria

- \`GET /convert?value=1&from=mi&to=km&precision=4\` answers 200 with \`{"value": 1.6093, "unit": "km"}\`.
- \`GET /convert?value=1&from=mi&to=km&precision=0\` answers 200 with \`{"value": 2, "unit": "km"}\`.
- A \`precision\` outside 0 to 6, or not an integer, answers 400 with \`{"error": "<message>"}\`.`,
    parent: PARENT_KEY,
    blockedBy: ["TAL-2"],
    signature: /\bprecision\b/i,
  },
];

export const SUB_TICKET_KEYS: readonly string[] = SEED_TICKETS.flatMap((ticket) =>
  ticket.parent === null ? [] : [ticket.key],
);
