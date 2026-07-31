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
	type Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const { execFileSync } = process.getBuiltinModule("child_process");
const bunTestServices = BunChildProcessSpawner.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);
const {
	fs,
	path: pathService,
	spawner,
} = Effect.runSync(
	Effect.gen(function* () {
		return {
			fs: yield* FileSystem.FileSystem,
			path: yield* Path.Path,
			spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
		};
	}).pipe(Effect.provide(bunTestServices)),
);

const PANE_WIDTH = 200;
const PANE_HEIGHT = 50;
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;
const REPOSITORY_AGENT_DIR = Effect.runSync(
	pathService.fromFileUrl(new URL("../..", import.meta.url)),
);
const e2eEnabled = Effect.runSync(
	Config.option(Config.nonEmptyString("PI_E2E")),
).pipe(Option.exists((value) => value === "1"));

export interface StartPiOptions {
	args?: readonly string[];
	files?: Readonly<Record<string, string>>;
	env?: Readonly<Record<string, string>>;
	readyTimeoutMs?: number;
}

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

export function runEffect<A, E>(effect: Effect.Effect<A, E>): () => Promise<A> {
	return () => Effect.runPromise(effect);
}

type TestEffectError =
	| Cause.TimeoutError
	| PlatformError.PlatformError
	| Schema.SchemaError;

export function testEffect(
	name: string,
	body: () => Generator<Effect.Effect<unknown, TestEffectError>, void, never>,
): void {
	test(name, runEffect(Effect.gen(body)));
}

const tmux = Effect.fn("tmux")(function* (...args: string[]) {
	return yield* spawner.string(ChildProcess.make("tmux", args));
});

/** tmux runs the pane command through a shell, so paths must be quoted. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Unique per session so parallel test files never collide on a tmux name. */
let sessionCounter = 0;

export const readStderr = Effect.fn("readStderr")(function* (
	session: PiSession,
) {
	return yield* fs
		.readFileString(session.stderrPath)
		.pipe(Effect.orElseSucceed(() => ""));
});

export const isDead = Effect.fn("isDead")(function* (session: PiSession) {
	return yield* tmux(
		"list-panes",
		"-t",
		session.name,
		"-F",
		"#{pane_dead}",
	).pipe(
		Effect.map((output) => output.trim() === "1"),
		Effect.orElseSucceed(() => true),
	);
});

export const capture = Effect.fn("capture")(function* (
	session: PiSession,
	scrollback = false,
) {
	const args = ["capture-pane", "-p", "-J", "-t", session.name];
	if (scrollback) args.push("-S", "-");
	return yield* tmux(...args).pipe(Effect.orElseSucceed(() => ""));
});

export const startPi = Effect.fn("startPi")(function* (
	options: StartPiOptions = {},
) {
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

	for (const [relative, contents] of Object.entries(options.files ?? {})) {
		const filePath = pathService.join(cwd, relative);
		yield* fs.makeDirectory(pathService.dirname(filePath), { recursive: true });
		yield* fs.writeFileString(filePath, contents);
	}

	const name = `pi-e2e-${process.pid}-${sessionCounter++}`;
	const stderrPath = pathService.join(root, "pi.stderr.log");
	const piArgs = ["pi", "--session-dir", sessionDir, "--no-extensions"];
	for (const entry of yield* fs.readDirectory(
		pathService.join(REPOSITORY_AGENT_DIR, "extensions"),
	)) {
		const extensionPath = pathService.join(
			REPOSITORY_AGENT_DIR,
			"extensions",
			entry,
			"index.ts",
		);
		if (yield* fs.exists(extensionPath)) {
			piArgs.push("--extension", extensionPath);
		}
	}
	piArgs.push(...(options.args ?? []));
	const command = piArgs.map(shellQuote).join(" ");
	const environment: Record<string, string> = {
		PI_SKIP_VERSION_CHECK: "1",
		...options.env,
		PI_CODING_AGENT_DIR: agentDir,
	};

	yield* tmux(
		"new-session",
		"-d",
		"-s",
		name,
		"-x",
		String(PANE_WIDTH),
		"-y",
		String(PANE_HEIGHT),
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
		timeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS,
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
	const poll = Effect.gen(function* () {
		const text = yield* capture(session, options.scrollback);
		if (typeof match === "function" ? match(text) : match.test(text)) {
			return { done: true, text };
		}
		if (yield* isDead(session)) {
			return yield* Effect.die(
				new Error(
					`pi exited before ${description}\n` +
						`--- stderr ---\n${yield* readStderr(session)}\n--- pane ---\n${text}`,
				),
			);
		}
		yield* Effect.sleep(POLL_INTERVAL_MS);
		return { done: false, text };
	}).pipe(
		Effect.repeat({ until: ({ done }) => done }),
		Effect.map(({ text }) => text),
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

export const sendKeys = Effect.fn("sendKeys")(function* (
	session: PiSession,
	...keys: string[]
) {
	yield* tmux("send-keys", "-t", session.name, ...keys);
});

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
	const poll = Effect.gen(function* () {
		const content = yield* fs.readFileString(filePath).pipe(Effect.option);
		if (Option.isSome(content)) return content.value;
		if (yield* isDead(session)) {
			return yield* Effect.die(
				new Error(
					`pi exited before writing ${relative}\n--- stderr ---\n${yield* readStderr(session)}`,
				),
			);
		}
		yield* Effect.sleep(POLL_INTERVAL_MS);
	}).pipe(
		Effect.repeat({ until: (content) => content !== undefined }),
		Effect.map((content) => content as string),
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

export const workspaceFile = Effect.fn("workspaceFile")(function* (
	session: PiSession,
	relative: string,
) {
	return yield* fs.readFileString(pathService.join(session.cwd, relative));
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
	Effect.gen(function* () {
		const value = yield* startPi();
		session = value;
		setSession(value);
		if (initialize) yield* initialize(value);
	}).pipe(runEffect, before);
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
