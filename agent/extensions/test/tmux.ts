/**
 * End-to-end harness: drives the real `pi` binary inside a real tmux pane.
 *
 * These tests exercise the extensions as the user actually runs them — real
 * TUI, real terminal, real model — in a throwaway working directory. Anything
 * that only crashes under a live TTY (a bad footer component, a broken entry
 * renderer) fails here and nowhere else.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Clock, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const { execFileSync } = process.getBuiltinModule("child_process");
const bunTestServices = BunChildProcessSpawner.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);
const { fs, path: pathService } = Effect.runSync(
	Effect.gen(function* () {
		return { fs: yield* FileSystem.FileSystem, path: yield* Path.Path };
	}).pipe(Effect.provide(bunTestServices)),
);

function runFileSystem<A, E>(effect: Effect.Effect<A, E>) {
	return Effect.runSync(effect);
}
const PANE_WIDTH = 200;
const PANE_HEIGHT = 50;
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;
const REPOSITORY_AGENT_DIR = Effect.runSync(
	pathService.fromFileUrl(new URL("../..", import.meta.url)),
);

export interface StartPiOptions {
	/** Extra CLI arguments appended after the harness defaults. */
	args?: readonly string[];
	/** Files to create in the workspace before pi starts, keyed by relative path. */
	files?: Readonly<Record<string, string>>;
	/** Extra environment variables for the pi process. */
	env?: Readonly<Record<string, string>>;
	/** Milliseconds to wait for the prompt to appear. */
	readyTimeoutMs?: number;
}

export interface WaitOptions {
	timeoutMs?: number;
	/** Include scrollback, not just the visible pane. */
	scrollback?: boolean;
	/** Describes what was expected; shown when the wait times out. */
	description?: string;
}

export interface PiSession {
	/** tmux session name. */
	readonly name: string;
	/** Throwaway working directory pi was launched in. */
	readonly cwd: string;
	/** Throwaway agent directory used for all mutable global state. */
	readonly agentDir: string;
	/** Path pi's stderr is redirected to. */
	readonly stderrPath: string;
}

function tmux(...args: string[]): string {
	return execFileSync("tmux", args, { encoding: "utf8" });
}

function tmuxAsync(...args: string[]): Promise<string> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			return yield* spawner.string(ChildProcess.make("tmux", args));
		}).pipe(Effect.provide(bunTestServices)),
	);
}

function sleep(ms: number): Promise<void> {
	return Effect.runPromise(Effect.sleep(ms));
}

/** tmux runs the pane command through a shell, so paths must be quoted. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Unique per session so parallel test files never collide on a tmux name. */
let sessionCounter = 0;

export function readStderr(session: PiSession): string {
	try {
		return runFileSystem(fs.readFileString(session.stderrPath));
	} catch {
		return "";
	}
}

export function isDead(session: PiSession): boolean {
	try {
		return (
			tmux("list-panes", "-t", session.name, "-F", "#{pane_dead}").trim() ===
			"1"
		);
	} catch {
		return true;
	}
}

/** Visible pane text with colors stripped and wrapped lines joined. */
export function capture(session: PiSession, scrollback = false): string {
	const args = ["capture-pane", "-p", "-J", "-t", session.name];
	if (scrollback) args.push("-S", "-");
	try {
		return tmux(...args);
	} catch {
		return "";
	}
}

export async function startPi(
	options: StartPiOptions = {},
): Promise<PiSession> {
	const root = runFileSystem(fs.makeTempDirectory({ prefix: "pi-e2e-" }));
	const cwd = pathService.join(root, "workspace");
	const agentDir = pathService.join(root, "agent");
	const sessionDir = pathService.join(root, "sessions");
	runFileSystem(fs.makeDirectory(cwd, { recursive: true }));
	runFileSystem(fs.makeDirectory(agentDir, { recursive: true, mode: 0o700 }));
	runFileSystem(fs.makeDirectory(sessionDir, { recursive: true }));

	const sourceAgentDir = getAgentDir();
	for (const name of [
		"settings.json",
		"auth.json",
		"keybindings.json",
		"models.json",
		"gpt-fast-mode.json",
	]) {
		const source = pathService.join(sourceAgentDir, name);
		if (runFileSystem(fs.exists(source)))
			runFileSystem(fs.copyFile(source, pathService.join(agentDir, name)));
	}
	runFileSystem(
		fs.copy(
			pathService.join(REPOSITORY_AGENT_DIR, "themes"),
			pathService.join(agentDir, "themes"),
		),
	);

	for (const [relative, contents] of Object.entries(options.files ?? {})) {
		const path = pathService.join(cwd, relative);
		runFileSystem(
			fs.makeDirectory(pathService.dirname(path), { recursive: true }),
		);
		runFileSystem(fs.writeFileString(path, contents));
	}

	const name = `pi-e2e-${process.pid}-${sessionCounter++}`;
	const stderrPath = pathService.join(root, "pi.stderr.log");
	const piArgs = ["pi", "--session-dir", sessionDir, "--no-extensions"];
	for (const entry of runFileSystem(
		fs.readDirectory(pathService.join(REPOSITORY_AGENT_DIR, "extensions")),
	)) {
		const path = pathService.join(
			REPOSITORY_AGENT_DIR,
			"extensions",
			entry,
			"index.ts",
		);
		if (runFileSystem(fs.exists(path))) piArgs.push("--extension", path);
	}
	piArgs.push(...(options.args ?? []));
	const command = piArgs.map(shellQuote).join(" ");

	const environment: Record<string, string> = {
		PI_SKIP_VERSION_CHECK: "1",
		...options.env,
		PI_CODING_AGENT_DIR: agentDir,
	};

	tmux(
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
	tmux("set-option", "-t", name, "remain-on-exit", "on");

	const session: PiSession = { name, cwd, agentDir, stderrPath };
	try {
		// The footer's cwd line is the last thing painted on a healthy startup.
		await waitFor(session, /\$?\s*\d+(\.\d+)?%\/\d/, {
			timeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS,
			description: "pi footer to render (startup)",
		});
	} catch (error) {
		await stop(session);
		throw error;
	}
	return session;
}

/**
 * Polls the pane until `match` is satisfied. Fails immediately — rather than
 * after the full timeout — when pi has died, and reports its stderr.
 */
export async function waitFor(
	session: PiSession,
	match: RegExp | ((text: string) => boolean),
	options: WaitOptions = {},
): Promise<string> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const deadline = Effect.runSync(Clock.currentTimeMillis) + timeoutMs;
	const matches = (text: string) =>
		typeof match === "function" ? match(text) : match.test(text);

	let text = "";
	while (Effect.runSync(Clock.currentTimeMillis) < deadline) {
		text = capture(session, options.scrollback);
		if (matches(text)) return text;
		if (isDead(session)) {
			throw new Error(
				`pi exited before ${options.description ?? String(match)}\n` +
					`--- stderr ---\n${readStderr(session)}\n--- pane ---\n${text}`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`timed out after ${timeoutMs}ms waiting for ${options.description ?? String(match)}\n` +
			`--- stderr ---\n${readStderr(session)}\n--- pane ---\n${text}`,
	);
}

/** Types `text` into the prompt and submits it. */
export async function prompt(session: PiSession, text: string): Promise<void> {
	await tmuxAsync("send-keys", "-t", session.name, "-l", text);
	await sleep(150);
	await tmuxAsync("send-keys", "-t", session.name, "Enter");
}

/** Sends raw tmux key names, e.g. `sendKeys(session, "C-o")`. */
export async function sendKeys(
	session: PiSession,
	...keys: string[]
): Promise<void> {
	await tmuxAsync("send-keys", "-t", session.name, ...keys);
}

/**
 * Cumulative agent run time as reported by the session-timer status line.
 * The timer only prints `(session …)` at agent_end, and the total is
 * monotonic, which makes it a reliable edge for "a turn just finished".
 */
export function sessionElapsedSeconds(pane: string): number | undefined {
	const match = /\(session (?:(\d+)m)?(\d+)s\)/.exec(pane);
	if (!match) return undefined;
	return Number(match[1] ?? 0) * 60 + Number(match[2]);
}

/**
 * Submits a prompt and waits for that turn to settle. Turn completion is an
 * edge, not a state: a previous turn leaves its own `(session …)` on screen,
 * so this waits for the cumulative total to move past where it started.
 */
export async function runTask(
	session: PiSession,
	text: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
	const before = sessionElapsedSeconds(capture(session));
	await prompt(session, text);
	return waitFor(
		session,
		(pane) => {
			const now = sessionElapsedSeconds(pane);
			return now !== undefined && (before === undefined || now > before);
		},
		{ timeoutMs, description: `task to settle: ${text.slice(0, 60)}` },
	);
}

/** Waits for the agent to produce a file in the workspace. */
export async function waitForFile(
	session: PiSession,
	relative: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
	const path = pathService.join(session.cwd, relative);
	const deadline = Effect.runSync(Clock.currentTimeMillis) + timeoutMs;
	while (Effect.runSync(Clock.currentTimeMillis) < deadline) {
		try {
			return runFileSystem(fs.readFileString(path));
		} catch {
			// Not written yet.
		}
		if (isDead(session)) {
			throw new Error(
				`pi exited before writing ${relative}\n--- stderr ---\n${readStderr(session)}`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`timed out after ${timeoutMs}ms waiting for ${relative}\n--- pane ---\n${capture(session)}`,
	);
}

export function workspaceFile(session: PiSession, relative: string): string {
	return runFileSystem(
		fs.readFileString(pathService.join(session.cwd, relative)),
	);
}

export async function stop(session: PiSession): Promise<void> {
	try {
		tmux("kill-session", "-t", session.name);
	} catch {
		// Session already gone.
	}
	try {
		runFileSystem(
			fs.remove(pathService.join(session.cwd, ".."), {
				recursive: true,
				force: true,
			}),
		);
	} catch {
		// Best effort: a leftover tmp dir must not fail a passing test.
	}
}

/** Skips live suites unless explicitly enabled and their binaries are available. */
export function e2eUnavailable(): string | undefined {
	if (process.env.PI_E2E !== "1") return "set PI_E2E=1 to run live E2E tests";
	for (const binary of ["tmux", "pi"]) {
		try {
			execFileSync("which", [binary], { stdio: "ignore" });
		} catch {
			return `${binary} is not installed`;
		}
	}
	return undefined;
}
