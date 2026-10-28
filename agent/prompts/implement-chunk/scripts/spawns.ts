// The spawn registry's writes: `chunk spawn add` registers a subagent, and `chunk spawn set`
// changes its row. The subagents launcher runs both around every launch it is given a state
// folder for.

import { appendFileSync, existsSync, linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  SPAWN_COLUMNS,
  SPAWN_KINDS,
  SPAWN_STATES,
  type Spawn,
  type SpawnColumn,
  isSpawnDepth,
  parseSpawns,
} from "./state.ts";
import { Refusal, tsvLine } from "./tsv.ts";

/** What `spawn add` writes in a column the command leaves out. Every other column is required. */
const NEW_SPAWN: Partial<Record<SpawnColumn, string>> = { unit: "-", state: "running" };

function spawnValues(args: readonly string[]): Map<SpawnColumn, string> {
  const values = new Map<SpawnColumn, string>();
  const settable = SPAWN_COLUMNS.filter((name) => name !== "session" && name !== "recorded_at");

  for (const arg of args) {
    const split = arg.indexOf("=");
    const column = settable.find((name) => name === arg.slice(0, split));
    const value = arg.slice(split + 1);

    if (split === -1 || column === undefined || value === "") {
      throw new Refusal(
        `not <column>=<value> with a spawns.tsv column and a value: ${arg}\ncolumns: ${settable.join(", ")}`,
      );
    }

    if (values.has(column)) throw new Refusal(`column given twice: ${column}`);

    if (column === "kind" && !SPAWN_KINDS.some((kind) => kind === value)) {
      throw new Refusal(`not a subagent kind: ${value}\nkinds: ${SPAWN_KINDS.join(", ")}`);
    }

    if (column === "depth" && !isSpawnDepth(value)) {
      throw new Refusal(`not a depth below the root, 1 or more: ${value}`);
    }

    if (column === "state" && !SPAWN_STATES.some((state) => state === value)) {
      throw new Refusal(`not a spawn state: ${value}\nstates: ${SPAWN_STATES.join(", ")}`);
    }

    values.set(column, value);
  }

  return values;
}

function spawnCells(spawn: Spawn): Record<SpawnColumn, string> {
  return {
    session: spawn.session,
    parent: spawn.parent,
    kind: spawn.kind,
    role: spawn.role,
    depth: String(spawn.depth),
    unit: spawn.unit,
    name: spawn.name,
    state: spawn.state,
    recorded_at: spawn.recordedAt,
  };
}

/** Creates the registry with its header, whole, unless another launch got there first. */
function createRegistry(path: string): void {
  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, `${tsvLine(SPAWN_COLUMNS)}\n`);

  try {
    linkSync(temporary, path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Registers a subagent (`add`) or changes its row (`set`) by appending the session's whole row,
 * so launches that start or end at once never overwrite each other. The last row per session
 * stands.
 */
export function writeSpawn(path: string, mode: "add" | "set", args: readonly string[]): string {
  const [session = "", ...assignments] = args;

  if (session === "" || (mode === "set" && assignments.length === 0)) {
    throw new Refusal(`spawn ${mode} takes <session> <column>=<value>...`);
  }

  const values = spawnValues(assignments);
  const text = existsSync(path) ? readFileSync(path, "utf8") : null;

  const current = (text === null ? [] : parseSpawns(path, text)).findLast(
    (spawn) => spawn.session === session,
  );

  if (mode === "add" && current !== undefined) {
    throw new Refusal(`${path}: spawn ${session} exists; change its state with spawn set`);
  }

  if (mode === "set" && current === undefined) throw new Refusal(`${path}: no spawn ${session}`);

  const cells = current === undefined ? null : spawnCells(current);

  const row = SPAWN_COLUMNS.map((column) => {
    if (column === "session") return session;

    if (column === "recorded_at") return new Date().toISOString();

    const value = values.get(column) ?? cells?.[column] ?? NEW_SPAWN[column];

    if (value === undefined) throw new Refusal(`spawn add needs ${column}=<value>`);

    return value;
  });

  // Built before the registry is created, so a refused cell leaves a fresh state folder as it was.
  const line = `${tsvLine(row)}\n`;

  if (text === null) createRegistry(path);

  appendFileSync(path, line);

  const shown = SPAWN_COLUMNS.map((column, index) => `${column}=${row[index]}`);

  return `${path}: ${mode} ${shown.join(" ")}`;
}
