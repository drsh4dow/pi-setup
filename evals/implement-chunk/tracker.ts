#!/usr/bin/env node
// The fake tracker the fixture's docs/agents/issue-tracker.md names. It behaves like Linear with
// its GitHub integration on: a pull request whose branch, title, or body carries a ticket key moves
// that ticket to Done when it merges or closes, whatever its base (trap T4). The fake gh calls
// `githubTransition` for that. Every call appends one JSON line to $TRACKER_LOG.
//
//   tracker view <key> | list [--parent <key>] [--state <state>]
//   tracker comment <key> --body-file <path|-> | state <key> <state> | close <key>

import { appendFileSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import type { JsonValue } from "./json.ts";
import { withLock } from "./lock.ts";
import type { SeedTicket } from "./tickets.ts";

export const TicketState = Schema.Literals(["Todo", "In Progress", "Done"]);

export type TicketState = typeof TicketState.Type;

const Ticket = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  body: Schema.String,
  parent: Schema.NullOr(Schema.String),
  blockedBy: Schema.Array(Schema.String),
  state: TicketState,
  comments: Schema.Array(Schema.Struct({ at: Schema.String, body: Schema.String })),
});

export type Ticket = typeof Ticket.Type;

export const TrackerState = Schema.Struct({ tickets: Schema.Array(Ticket) });

export type TrackerState = typeof TrackerState.Type;

export const StateChange = Schema.Struct({
  key: Schema.String,
  from: TicketState,
  to: TicketState,
});

export type StateChange = typeof StateChange.Type;

/** Who made a change: an agent through the CLI, or the GitHub integration on a PR event. */
export const TrackerLogEntry = Schema.Struct({
  at: Schema.String,
  actor: Schema.Literals(["agent", "github"]),
  argv: Schema.Array(Schema.String),
  changes: Schema.Array(StateChange),
  error: Schema.NullOr(Schema.String),
});

export type TrackerLogEntry = typeof TrackerLogEntry.Type;

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(TrackerState));

export interface TrackerPaths {
  readonly state: string;
  readonly log: string;
}

export function seedTracker(tickets: readonly SeedTicket[]): TrackerState {
  return {
    tickets: tickets.map((ticket) => ({ ...ticket, state: "Todo", comments: [] })),
  };
}

export function writeTrackerState(path: string, state: TrackerState) {
  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, path);
}

export function readTrackerState(path: string): TrackerState {
  return decodeState(readFileSync(path, "utf8"));
}

const KEY = /\b[A-Z]{2,5}-\d+\b/g;

/** The ticket keys a pull request's branch, title, or body carries, as the integration reads them. */
export function linkedKeys(state: TrackerState, texts: readonly string[]): string[] {
  const known = new Set(state.tickets.map((ticket) => ticket.key));
  const found = new Set<string>();

  for (const text of texts) {
    for (const match of text.toUpperCase().matchAll(KEY)) {
      if (known.has(match[0])) found.add(match[0]);
    }
  }

  return [...found];
}

function withState(state: TrackerState, key: string, to: TicketState) {
  const ticket = state.tickets.find((candidate) => candidate.key === key);

  if (ticket === undefined) throw new TrackerError(`no ticket ${key}`);

  const change = { key, from: ticket.state, to } satisfies StateChange;

  const next = {
    tickets: state.tickets.map((candidate) =>
      candidate.key === key ? { ...candidate, state: to } : candidate,
    ),
  };

  return { next, change };
}

export class TrackerError extends Error {}

/**
 * Moves every ticket a merged or closed pull request links to Done, as Linear's GitHub integration
 * does on any base branch. Returns the changes it made.
 */
export function githubTransition(
  paths: TrackerPaths,
  pr: {
    readonly number: number;
    readonly branch: string;
    readonly title: string;
    readonly body: string;
  },
  event: "merged" | "closed",
): StateChange[] {
  return withLock(paths.state, () => {
    let state = readTrackerState(paths.state);
    const changes: StateChange[] = [];

    for (const key of linkedKeys(state, [pr.branch, pr.title, pr.body])) {
      const { next, change } = withState(state, key, "Done");

      state = next;

      if (change.from !== change.to) changes.push(change);
    }

    writeTrackerState(paths.state, state);
    appendLog(paths.log, {
      at: new Date().toISOString(),
      actor: "github",
      argv: [`pr-${event}`, `#${pr.number}`, pr.branch],
      changes,
      error: null,
    });

    return changes;
  });
}

function appendLog(path: string, entry: TrackerLogEntry) {
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

function bodyFrom(path: string | undefined): string {
  if (path === undefined) throw new TrackerError("comment needs --body-file <path|->");

  return readFileSync(path === "-" ? 0 : path, "utf8");
}

function ticketOf(state: TrackerState, key: string | undefined): Ticket {
  const wanted = key?.toUpperCase();
  const ticket = state.tickets.find((candidate) => candidate.key === wanted);

  if (ticket === undefined) throw new TrackerError(`no ticket ${key ?? "(none given)"}`);

  return ticket;
}

function view(state: TrackerState, ticket: Ticket) {
  const children = state.tickets
    .filter((candidate) => candidate.parent === ticket.key)
    .map((child) => ({ key: child.key, title: child.title, state: child.state }));

  return { ...ticket, children };
}

interface Outcome {
  readonly stdout: string;
  readonly state: TrackerState;
  readonly changes: readonly StateChange[];
}

const decodeTicketState = Schema.decodeUnknownSync(TicketState);

/** One CLI call against the state, as a pure step the tests drive. */
export function trackerCommand(state: TrackerState, argv: readonly string[]): Outcome {
  const [command, ...rest] = argv;

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      parent: { type: "string" },
      state: { type: "string" },
      "body-file": { type: "string" },
    },
  });

  const read = (value: JsonValue): Outcome => ({
    stdout: `${JSON.stringify(value, null, 2)}\n`,
    state,
    changes: [],
  });

  switch (command) {
    case "view":
      return read(view(state, ticketOf(state, positionals[0])));

    case "list":
      return read(
        state.tickets
          .filter(
            (ticket) =>
              values.parent === undefined || ticket.parent === values.parent.toUpperCase(),
          )
          .filter((ticket) => values.state === undefined || ticket.state === values.state)
          .map(({ key, title, state: ticketState, blockedBy }) => ({
            key,
            title,
            state: ticketState,
            blockedBy,
          })),
      );

    case "comment": {
      const ticket = ticketOf(state, positionals[0]);
      const comment = { at: new Date().toISOString(), body: bodyFrom(values["body-file"]) };

      return {
        stdout: `commented on ${ticket.key}\n`,
        state: {
          tickets: state.tickets.map((candidate) =>
            candidate.key === ticket.key
              ? { ...candidate, comments: [...candidate.comments, comment] }
              : candidate,
          ),
        },
        changes: [],
      };
    }

    case "state":
    case "close": {
      const ticket = ticketOf(state, positionals[0]);
      const to = command === "close" ? "Done" : decodeTicketState(positionals[1]);
      const { next, change } = withState(state, ticket.key, to);

      return {
        stdout: `${ticket.key}: ${change.from} -> ${change.to}\n`,
        state: next,
        changes: change.from === change.to ? [] : [change],
      };
    }

    default:
      throw new TrackerError(
        `unknown command ${command ?? "(none)"}; try view, list, comment, state, close`,
      );
  }
}

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") {
    console.error(`tracker: ${name} is not set`);
    process.exit(2);
  }

  return value;
}

function main() {
  const paths = { state: required("TRACKER_STATE"), log: required("TRACKER_LOG") };
  const argv = process.argv.slice(2);

  withLock(paths.state, () => {
    const entry = { at: new Date().toISOString(), actor: "agent", argv } as const;

    try {
      const outcome = trackerCommand(readTrackerState(paths.state), argv);

      writeTrackerState(paths.state, outcome.state);
      appendLog(paths.log, { ...entry, changes: outcome.changes, error: null });
      process.stdout.write(outcome.stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      appendLog(paths.log, { ...entry, changes: [], error: message });
      console.error(`tracker: ${message}`);
      process.exitCode = 1;
    }
  });
}

if (import.meta.main) main();
