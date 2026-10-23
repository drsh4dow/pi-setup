// A two-level directory scan after each tool call does not need an Effect FileSystem service.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, readdirSync } from "node:fs";
// Pure path operations do not need an Effect service.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Config, Effect, Schema } from "effect";

const COMMAND_TIMEOUT_MS = 5000;

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  message: Schema.String,
}) {}

function childDirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? [join(dir, entry.name)] : [],
  );
}

function isCheckout(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

// Worktrees sit at `.worktrees/<branch>` or `.worktrees/<repo>/<branch>`.
function scanCheckouts(root: string): Set<string> {
  const checkouts = new Set<string>();

  for (const dir of childDirectories(root)) {
    if (isCheckout(dir)) {
      checkouts.add(dir);
      continue;
    }

    for (const child of childDirectories(dir)) {
      if (isCheckout(child)) checkouts.add(child);
    }
  }

  return checkouts;
}

export function trackCheckouts(root: string): () => string[] {
  let known = scanCheckouts(root);

  return () => {
    const current = scanCheckouts(root);
    const added = [...current.difference(known)];

    known = current;

    return added;
  };
}

const run = Effect.fnUntraced(function* (pi: ExtensionAPI, command: string, args: string[]) {
  const commandLine = [command, ...args].join(" ");

  const result = yield* Effect.tryPromise({
    try: () => pi.exec(command, args, { timeout: COMMAND_TIMEOUT_MS }),
    catch: (cause) => new CommandFailed({ command: commandLine, message: String(cause) }),
  });

  if (result.killed) {
    return yield* new CommandFailed({
      command: commandLine,
      message: `timed out after ${COMMAND_TIMEOUT_MS} ms`,
    });
  }

  if (result.code !== 0) {
    return yield* new CommandFailed({ command: commandLine, message: result.stderr.trim() });
  }

  return result.stdout.trim();
});

const openInHerdr = Effect.fnUntraced(function* (pi: ExtensionAPI, checkout: string) {
  const commonGitDir = yield* run(pi, "git", [
    "-C",
    checkout,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);

  // herdr rejects a linked checkout as `--cwd` and groups the worktree under the main checkout.
  yield* run(pi, "herdr", [
    "worktree",
    "open",
    "--cwd",
    dirname(commonGitDir),
    "--path",
    checkout,
    "--no-focus",
  ]);
});

const herdrEnv = Config.String("HERDR_ENV").pipe(Config.withDefault(""));

// Tool calls cannot run before `session_start`, so this stands in only until it does.
const noCheckoutsYet = (): string[] => [];

/**
 * Inside herdr, each checkout that appears under `<session directory>/.worktrees` opens as a
 * herdr workspace grouped under its repository. `herdr worktree open` is idempotent, so sessions
 * that see the same new checkout need no coordination.
 */
export default function herdrWorktreesExtension(pi: ExtensionAPI): void {
  if (Effect.runSync(herdrEnv) !== "1") return;

  let nextNewCheckouts = noCheckoutsYet;

  pi.on("session_start", (_event, ctx) => {
    nextNewCheckouts = trackCheckouts(join(ctx.cwd, ".worktrees"));
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    const openOrWarn = (checkout: string) =>
      openInHerdr(pi, checkout).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            ctx.ui.notify(
              `herdr did not open ${checkout}. \`${error.command}\` failed: ${error.message}`,
              "warning",
            ),
          ),
        ),
      );

    return Effect.runPromise(Effect.forEach(nextNewCheckouts(), openOrWarn, { discard: true }));
  });
}
