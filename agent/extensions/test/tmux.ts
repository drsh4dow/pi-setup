/**
 * End-to-end harness: drives the real `pi` binary inside a real tmux pane.
 *
 * These tests exercise the extensions as the user actually runs them — real
 * TUI, real terminal, real model — in a throwaway working directory. Anything
 * that only crashes under a live TTY (a bad footer component, a broken entry
 * renderer) fails here and nowhere else.
 */
import { execFile, execFileSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const PANE_WIDTH = 200;
const PANE_HEIGHT = 50;
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;
const REPOSITORY_AGENT_DIR = fileURLToPath(new URL("../..", import.meta.url));

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

async function tmuxAsync(...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("tmux", args, { encoding: "utf8" });
	return stdout;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** tmux runs the pane command through a shell, so paths must be quoted. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Unique per session so parallel test files never collide on a tmux name. */
let sessionCounter = 0;

export function readStderr(session: PiSession): string {
	try {
		return readFileSync(session.stderrPath, "utf8");
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
	const root = mkdtempSync(join(tmpdir(), "pi-e2e-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	mkdirSync(sessionDir, { recursive: true });

	const sourceAgentDir = getAgentDir();
	for (const name of [
		"settings.json",
		"auth.json",
		"keybindings.json",
		"models.json",
		"gpt-fast-mode.json",
	]) {
		const source = join(sourceAgentDir, name);
		if (existsSync(source)) copyFileSync(source, join(agentDir, name));
	}
	cpSync(join(REPOSITORY_AGENT_DIR, "themes"), join(agentDir, "themes"), {
		recursive: true,
	});

	for (const [relative, contents] of Object.entries(options.files ?? {})) {
		const path = join(cwd, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, contents);
	}

	const name = `pi-e2e-${process.pid}-${sessionCounter++}`;
	const stderrPath = join(root, "pi.stderr.log");
	const piArgs = ["pi", "--session-dir", sessionDir, "--no-extensions"];
	for (const entry of readdirSync(join(REPOSITORY_AGENT_DIR, "extensions"), {
		withFileTypes: true,
	})) {
		if (!entry.isDirectory()) continue;
		const path = join(
			REPOSITORY_AGENT_DIR,
			"extensions",
			entry.name,
			"index.ts",
		);
		if (existsSync(path)) piArgs.push("--extension", path);
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
	const deadline = Date.now() + timeoutMs;
	const matches = (text: string) =>
		typeof match === "function" ? match(text) : match.test(text);

	let text = "";
	while (Date.now() < deadline) {
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
	const path = join(session.cwd, relative);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return readFileSync(path, "utf8");
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
	return readFileSync(join(session.cwd, relative), "utf8");
}

export async function stop(session: PiSession): Promise<void> {
	try {
		tmux("kill-session", "-t", session.name);
	} catch {
		// Session already gone.
	}
	try {
		rmSync(join(session.cwd, ".."), { recursive: true, force: true });
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
