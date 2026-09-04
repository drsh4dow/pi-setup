/** Drives the real `pi` binary in tmux so live-TTY failures reach tests. */
import test, { after, before } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
	type Cause,
	Config,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	type PlatformError,
	Schedule,
	type Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const { execFileSync } = process.getBuiltinModule("child_process");
const bunTestServices = BunChildProcessSpawner.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);
const fs = Effect.runSync(
	FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer)),
);
const pathService = Effect.runSync(
	Path.Path.pipe(Effect.provide(BunPath.layer)),
);
const spawner = Effect.runSync(
	ChildProcessSpawner.ChildProcessSpawner.pipe(Effect.provide(bunTestServices)),
);

const DEFAULT_TIMEOUT_MS = 120_000;
const pollUntilSome = <A, E, R>(
	effect: Effect.Effect<Option.Option<A>, E, R>,
) =>
	effect.pipe(
		Effect.repeat({ schedule: Schedule.spaced(250), until: Option.isSome }),
		Effect.map(Option.getOrThrow),
	);
const REPOSITORY_AGENT_DIR = Effect.runSync(
	pathService.fromFileUrl(new URL("../..", import.meta.url)),
);
const e2eEnabled = Effect.runSync(
	Config.option(Config.nonEmptyString("PI_E2E")),
).pipe(Option.exists((value) => value === "1"));

export interface WaitOptions {
	timeoutMs?: number;
	scrollback?: boolean;
	description?: string;
}

export interface PiSession {
	readonly name: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly stderrPath: string;
}

type TestEffectError =
	| Cause.TimeoutError
	| Config.ConfigError
	| PlatformError.PlatformError
	| Schema.SchemaError;

export function testEffect(
	name: string,
	body: () => Generator<Effect.Effect<unknown, TestEffectError>, void, never>,
): void {
	test(name, () => Effect.runPromise(Effect.gen(body)));
}

const tmux = (...args: string[]) =>
	spawner.string(ChildProcess.make("tmux", args));

/** tmux runs the pane command through a shell, so paths must be quoted. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Unique per session so parallel test files never collide on a tmux name. */
let sessionCounter = 0;

export const readStderr = (session: PiSession) =>
	fs.readFileString(session.stderrPath).pipe(Effect.orElseSucceed(() => ""));

export const isDead = (session: PiSession) =>
	tmux("list-panes", "-t", session.name, "-F", "#{pane_dead}").pipe(
		Effect.map((output) => output.trim() === "1"),
		Effect.orElseSucceed(() => true),
	);

export function capture(session: PiSession, scrollback = false) {
	return tmux(
		"capture-pane",
		"-p",
		"-J",
		"-t",
		session.name,
		...(scrollback ? ["-S", "-"] : []),
	).pipe(Effect.orElseSucceed(() => ""));
}

const startPi = Effect.fn("startPi")(function* () {
	const root = yield* fs.makeTempDirectory({ prefix: "pi-e2e-" });
	const cwd = pathService.join(root, "workspace");
	const agentDir = pathService.join(root, "agent");
	const sessionDir = pathService.join(root, "sessions");
	yield* fs.makeDirectory(cwd, { recursive: true });
	yield* fs.makeDirectory(agentDir, { recursive: true, mode: 0o700 });
	yield* fs.makeDirectory(sessionDir, { recursive: true });

	const sourceAgentDir = getAgentDir();
	for (const name of [
		"settings.json",
		"auth.json",
		"keybindings.json",
		"models.json",
		"gpt-fast-mode.json",
	]) {
		const source = pathService.join(sourceAgentDir, name);
		if (yield* fs.exists(source)) {
			yield* fs.copyFile(source, pathService.join(agentDir, name));
		}
	}
	yield* fs.copy(
		pathService.join(REPOSITORY_AGENT_DIR, "themes"),
		pathService.join(agentDir, "themes"),
	);

	const name = `pi-e2e-${process.pid}-${sessionCounter++}`;
	const stderrPath = pathService.join(root, "pi.stderr.log");
	const piArgs = ["pi", "--session-dir", sessionDir, "--no-extensions"];
	for (const entry of yield* fs.readDirectory(
		pathService.join(REPOSITORY_AGENT_DIR, "extensions"),
	)) {
		const entryPath = pathService.join(
			REPOSITORY_AGENT_DIR,
			"extensions",
			entry,
		);
		const info = yield* fs.stat(entryPath);
		if (info.type === "File" && entry.endsWith(".ts")) {
			piArgs.push("--extension", entryPath);
		} else if (info.type === "Directory") {
			const indexPath = pathService.join(entryPath, "index.ts");
			if (yield* fs.exists(indexPath)) {
				piArgs.push("--extension", indexPath);
			}
		}
	}
	const command = piArgs.map(shellQuote).join(" ");
	const environment: Record<string, string> = {
		PI_SKIP_VERSION_CHECK: "1",
		// Fixture sessions must not report state to the parent's Herdr pane.
		HERDR_ENV: "0",
		PI_CODING_AGENT_DIR: agentDir,
	};

	yield* tmux(
		"new-session",
		"-d",
		"-s",
		name,
		"-x",
		"200",
		"-y",
		"50",
		"-c",
		cwd,
		...Object.entries(environment).flatMap(([key, value]) => [
			"-e",
			`${key}=${value}`,
		]),
		`${command} 2>${shellQuote(stderrPath)}`,
	);
	// Keep the pane inspectable after pi exits so crashes surface as assertions
	// instead of "no such session" noise.
	yield* tmux("set-option", "-t", name, "remain-on-exit", "on");

	const session: PiSession = { name, cwd, agentDir, stderrPath };
	yield* waitFor(session, /\$?\s*\d+(\.\d+)?%\/\d/, {
		timeoutMs: 60_000,
		description: "pi footer to render (startup)",
	}).pipe(Effect.onError(() => stop(session)));
	return session;
});

/** Polls until matched, failing early with diagnostics if pi exits. */
export const waitFor = Effect.fn("waitFor")(function* (
	session: PiSession,
	match: RegExp | ((text: string) => boolean),
	options: WaitOptions = {},
) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const description = options.description ?? String(match);
	const poll = pollUntilSome(
		Effect.gen(function* () {
			const text = yield* capture(session, options.scrollback);
			if (typeof match === "function" ? match(text) : match.test(text)) {
				return Option.some(text);
			}
			if (yield* isDead(session)) {
				return yield* Effect.die(
					new Error(
						`pi exited before ${description}\n` +
							`--- stderr ---\n${yield* readStderr(session)}\n--- pane ---\n${text}`,
					),
				);
			}
			return Option.none<string>();
		}),
	);

	return yield* poll.pipe(
		Effect.timeoutOrElse({
			duration: timeoutMs,
			orElse: () =>
				Effect.gen(function* () {
					return yield* Effect.die(
						new Error(
							`timed out after ${timeoutMs}ms waiting for ${description}\n` +
								`--- stderr ---\n${yield* readStderr(session)}\n` +
								`--- pane ---\n${yield* capture(session, options.scrollback)}`,
						),
					);
				}),
		}),
	);
});

export const prompt = Effect.fn("prompt")(function* (
	session: PiSession,
	text: string,
) {
	yield* tmux("send-keys", "-t", session.name, "-l", text);
	yield* Effect.sleep(150);
	yield* tmux("send-keys", "-t", session.name, "Enter");
});

export const sendKeys = (session: PiSession, ...keys: string[]) =>
	tmux("send-keys", "-t", session.name, ...keys).pipe(Effect.asVoid);

/** Cumulative run time emitted at agent_end. */
export function sessionElapsedSeconds(pane: string): number | undefined {
	const match = /\(session (?:(\d+)m)?(\d+)s\)/.exec(pane);
	if (!match) return undefined;
	return Number(match[1] ?? 0) * 60 + Number(match[2]);
}

/** Waits for the cumulative timer to move past the previous turn. */
export const runTask = Effect.fn("runTask")(function* (
	session: PiSession,
	text: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
) {
	const before = sessionElapsedSeconds(yield* capture(session));
	yield* prompt(session, text);
	return yield* waitFor(
		session,
		(pane) => {
			const now = sessionElapsedSeconds(pane);
			return now !== undefined && (before === undefined || now > before);
		},
		{ timeoutMs, description: `task to settle: ${text.slice(0, 60)}` },
	);
});

export const waitForFile = Effect.fn("waitForFile")(function* (
	session: PiSession,
	relative: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
) {
	const filePath = pathService.join(session.cwd, relative);
	const poll = pollUntilSome(
		Effect.gen(function* () {
			const content = yield* fs.readFileString(filePath).pipe(Effect.option);
			if (Option.isSome(content)) return content;
			if (yield* isDead(session)) {
				return yield* Effect.die(
					new Error(
						`pi exited before writing ${relative}\n--- stderr ---\n${yield* readStderr(session)}`,
					),
				);
			}
			return Option.none<string>();
		}),
	);

	return yield* poll.pipe(
		Effect.timeoutOrElse({
			duration: timeoutMs,
			orElse: () =>
				Effect.gen(function* () {
					return yield* Effect.die(
						new Error(
							`timed out after ${timeoutMs}ms waiting for ${relative}\n--- pane ---\n${yield* capture(session)}`,
						),
					);
				}),
		}),
	);
});

export const stop = Effect.fn("stop")(function* (session: PiSession) {
	yield* tmux("kill-session", "-t", session.name).pipe(Effect.ignore);
	yield* fs
		.remove(pathService.join(session.cwd, ".."), {
			recursive: true,
			force: true,
		})
		.pipe(Effect.ignore);
});

export function setupPiSession<E = never>(
	setSession: (session: PiSession) => void,
	initialize?: (session: PiSession) => Effect.Effect<void, E>,
): void {
	let session: PiSession | undefined;
	before(() =>
		Effect.runPromise(
			Effect.gen(function* () {
				const value = yield* startPi();
				session = value;
				setSession(value);
				if (initialize) yield* initialize(value);
			}),
		),
	);
	after(() => (session ? Effect.runPromise(stop(session)) : undefined));
}

export function e2eUnavailable(): string | undefined {
	if (!e2eEnabled) return "set PI_E2E=1 to run live E2E tests";
	for (const binary of ["tmux", "pi"]) {
		try {
			execFileSync("which", [binary], { stdio: "ignore" });
		} catch {
			return `${binary} is not installed`;
		}
	}
	return undefined;
}
