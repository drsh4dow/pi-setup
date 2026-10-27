// The doctor's boundary: everything it reads from the machine, parsed into plain values.
// doctor.ts judges these values.

import { spawnSync } from "node:child_process";
import {
  accessSync,
  readFileSync,
  constants,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { Option, Schema } from "effect";

// The environment a new terminal starts with, read from the shell newShellArgs starts.
export interface NewShell {
  shell: string;
  env: Map<string, string>;
}

export type ShellRead = { kind: "read"; shell: NewShell } | { kind: "failed"; reason: string };

export function parseShellEnv(output: string, marker: string) {
  const start = output.lastIndexOf(`${marker}\n`);

  if (start === -1) return undefined;

  const env = new Map<string, string>();

  for (const line of output.slice(start + marker.length + 1).split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);

    if (match) env.set(match[1], match[2]);
  }

  return env;
}

// The shell a new terminal starts: macOS terminals start login shells, and Linux terminal
// emulators start non-login ones.
export function newShellArgs(platform: NodeJS.Platform) {
  return platform === "darwin" ? ["-l", "-i"] : ["-i"];
}

// Starts that shell from a bare environment, so the result shows what the user's startup files
// set up and not what the doctor inherited.
export function readNewShell(home: string): ShellRead {
  const shell = process.env.SHELL || userInfo().shell || "/bin/sh";
  const marker = "__pi_setup_doctor_env__";

  const bare: NodeJS.ProcessEnv = {
    HOME: home,
    SHELL: shell,
    TERM: "dumb",
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };

  for (const name of [
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ])
    if (process.env[name]) bare[name] = process.env[name];

  const run = spawnSync(shell, [...newShellArgs(process.platform), "-c", `echo ${marker}; env`], {
    cwd: home,
    env: bare,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (run.error) return { kind: "failed", reason: `${shell} did not start: ${run.error.message}` };

  const env = parseShellEnv(run.stdout, marker);

  if (env) return { kind: "read", shell: { shell, env } };

  return {
    kind: "failed",
    reason: `${shell} exited ${run.status}: ${run.stderr.trim() || "(no output)"}`,
  };
}

// Finds a program the way a shell does when it runs a command: the first executable file on PATH.
export function resolveCommand(name: string, path: string) {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;

    const candidate = join(directory, name);

    try {
      accessSync(candidate, constants.X_OK);

      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory, so the shell would look in the next one.
    }
  }

  return undefined;
}

const PackageStatus = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      available: Schema.Boolean,
      packages: Schema.Array(Schema.Struct({ package: Schema.String, state: Schema.String })),
    }),
  ),
);

const decodePackageStatus = Schema.decodeUnknownOption(PackageStatus);

// The state mise reports for each declared system package, keyed "manager:package" as the
// config writes it. A manager this machine lacks is left out, since mise skips its packages.
export function parsePackageStatus(json: string) {
  const status = decodePackageStatus(json);

  if (Option.isNone(status)) return undefined;

  return new Map(
    Object.entries(status.value).flatMap(([manager, { available, packages }]) =>
      available
        ? packages.map((entry) => [`${manager}:${entry.package}`, entry.state] as const)
        : [],
    ),
  );
}

export type PackagesRead =
  | { kind: "read"; states: Map<string, string> }
  | { kind: "failed"; reason: string };

export function readSystemPackages(mise: string): PackagesRead {
  return inNeutralDirectory((neutral) => {
    const run = spawnSync(mise, ["bootstrap", "packages", "status", "--json"], {
      cwd: neutral,
      env: { ...process.env, MISE_CEILING_PATHS: neutral },
      encoding: "utf8",
      timeout: 60_000,
    });

    if (run.error || run.status !== 0)
      return {
        kind: "failed",
        reason: `mise bootstrap packages status --json failed: ${run.error?.message ?? run.stderr.trim()}`,
      };

    const states = parsePackageStatus(run.stdout);

    return states
      ? { kind: "read", states }
      : {
          kind: "failed",
          reason: "mise bootstrap packages status --json printed an unexpected shape",
        };
  });
}

// The "manager:package" keys of a tier file's [bootstrap.packages] table. [tools] keys such as
// "github:owner/repo" have the same shape, so only lines inside that table count.
export function parseDeclaredPackages(toml: string) {
  let inPackages = false;

  return toml.split("\n").flatMap((line) => {
    const table = /^\s*\[([^\]]+)\]\s*$/.exec(line);

    if (table) {
      inPackages = table[1]?.trim() === "bootstrap.packages";

      return [];
    }

    const key = inPackages ? /^\s*"([a-z-]+:[^"]+)"\s*=/.exec(line)?.[1] : undefined;

    return key ? [key] : [];
  });
}

export function readDeclaredPackages(file: string) {
  return parseDeclaredPackages(readFileSync(file, "utf8"));
}

export interface MiseTool {
  tool: string;
  version: string;
  installed: boolean;
  // The pi-setup-<tier> folder in mise's conf.d that requests the tool.
  tier: string;
}

const MiseList = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        version: Schema.String,
        installed: Schema.Boolean,
        source: Schema.optional(Schema.Struct({ path: Schema.String })),
      }),
    ),
  ),
);

const decodeMiseList = Schema.decodeUnknownOption(MiseList);

export type MiseRead = { kind: "read"; tools: MiseTool[] } | { kind: "failed"; reason: string };

export function listMiseTools(mise: string): MiseRead {
  // An empty working directory with a ceiling keeps project configs out, so only global config,
  // where setup links the tiers, decides what is listed.
  return inNeutralDirectory((neutral) => {
    const run = spawnSync(mise, ["ls", "--json"], {
      cwd: neutral,
      env: { ...process.env, MISE_CEILING_PATHS: neutral },
      encoding: "utf8",
      timeout: 60_000,
    });

    if (run.error || run.status !== 0)
      return {
        kind: "failed",
        reason: `mise ls --json failed: ${run.error?.message ?? run.stderr.trim()}`,
      };

    const list = decodeMiseList(run.stdout);

    if (Option.isNone(list))
      return { kind: "failed", reason: "mise ls --json printed an unexpected shape" };

    const tools = Object.entries(list.value).flatMap(([tool, entries]) =>
      entries.flatMap((entry) => {
        const tier = /pi-setup-([a-z]+)/.exec(entry.source?.path ?? "")?.[1];

        return tier ? [{ tool, version: entry.version, installed: entry.installed, tier }] : [];
      }),
    );

    return { kind: "read", tools };
  });
}

// Pi writes an empty auth.json on its first start, so only an entry per provider means a login.
const StoredLogins = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ type: Schema.String })),
);

const decodeStoredLogins = Schema.decodeUnknownOption(StoredLogins);

export function readStoredLogins(authFile: string) {
  let text;

  try {
    text = readFileSync(authFile, "utf8");
  } catch {
    return [];
  }

  return Option.match(decodeStoredLogins(text), {
    onNone: () => [],
    onSome: (logins) => Object.keys(logins),
  });
}

export type Link = { kind: "absent" } | { kind: "linked" } | { kind: "elsewhere"; target: string };

export function readLink(path: string, expected: string): Link {
  let stats;

  try {
    stats = lstatSync(path);
  } catch {
    return { kind: "absent" };
  }

  if (!stats.isSymbolicLink())
    return { kind: "elsewhere", target: "a real file or directory, not a link" };

  const target = resolve(dirname(path), readlinkSync(path));

  return realpathOrSelf(target) === realpathOrSelf(expected)
    ? { kind: "linked" }
    : { kind: "elsewhere", target };
}

export function realpathOrSelf(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// What Pi reports when it starts in RPC mode and lists its commands.
export interface PiLoad {
  listed: boolean;
  skillPaths: string[];
  errors: string[];
}

const RpcLine = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    command: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
    data: Schema.optional(
      Schema.Struct({
        commands: Schema.optional(
          Schema.Array(
            Schema.Struct({
              source: Schema.String,
              sourceInfo: Schema.optional(Schema.Struct({ path: Schema.String })),
            }),
          ),
        ),
      }),
    ),
  }),
);

const decodeRpcLine = Schema.decodeUnknownOption(RpcLine);

export function parsePiOutput(output: string): PiLoad {
  const load: PiLoad = { listed: false, skillPaths: [], errors: [] };

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;

    const message = decodeRpcLine(line);

    if (Option.isNone(message)) {
      // Pi prints extension load failures as plain lines, outside the JSON protocol.
      if (/error|fail/i.test(line)) load.errors.push(line.trim());
      continue;
    }

    const { type, command, error, data } = message.value;

    if (type === "extension_error") load.errors.push(error ?? line.trim());

    if (command !== "get_commands" || !data?.commands) continue;

    load.listed = true;

    for (const entry of data.commands)
      if (entry.source === "skill" && entry.sourceInfo) load.skillPaths.push(entry.sourceInfo.path);
  }

  return load;
}

export type PiRun = { kind: "ran"; load: PiLoad } | { kind: "failed"; reason: string };

export function probePi(pi: string, env: NodeJS.ProcessEnv): PiRun {
  // Started from an empty directory, so no project's .pi folder adds to what loads.
  return inNeutralDirectory((neutral) => {
    const run = spawnSync(pi, ["--mode", "rpc", "--no-session"], {
      cwd: neutral,
      env,
      input: `${JSON.stringify({ id: "doctor", type: "get_commands" })}\n`,
      encoding: "utf8",
      timeout: 120_000,
    });

    if (run.error)
      return { kind: "failed", reason: `${pi} --mode rpc did not finish: ${run.error.message}` };

    // Pi exits 0 once stdin closes, so any other status means it broke after listing.
    if (run.status !== 0)
      return {
        kind: "failed",
        reason: `${pi} --mode rpc exited with ${run.status ?? run.signal}: ${run.stderr.trim()}`,
      };

    return { kind: "ran", load: parsePiOutput(`${run.stdout}\n${run.stderr}`) };
  });
}

export type CommandRun = { ok: true; output: string } | { ok: false; output: string };

export function runCommand({
  command,
  args,
  env,
  cwd,
  timeout,
}: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeout: number;
}): CommandRun {
  const run = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout });
  const output = run.error ? run.error.message : `${run.stdout}${run.stderr}`.trim();

  return run.status === 0
    ? { ok: true, output }
    : { ok: false, output: output || `exit ${run.status}` };
}

function inNeutralDirectory<T>(use: (directory: string) => T) {
  const directory = mkdtempSync(join(tmpdir(), "pi-doctor-"));

  try {
    return use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
