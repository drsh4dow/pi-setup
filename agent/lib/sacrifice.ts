const { execFileSync } = process.getBuiltinModule("node:child_process");

// Sacrifice Preference: pi-spawned work raises its own oom_score_adj so that under
// system memory pressure earlyoom kills the task, never the session. Unprivileged
// processes may only raise the value, which is all this needs.
const OOM_SCORE_ADJ = 500;
const LINUX = process.platform === "linux";

// The group redirection also silences the shell's redirection-failure message on
// read-only /proc mounts.
export const SACRIFICE_COMMAND_PREFIX = `{ echo ${OOM_SCORE_ADJ} > /proc/self/oom_score_adj; } 2>/dev/null`;

export function tagCommand(command: string): string {
	return LINUX ? `${SACRIFICE_COMMAND_PREFIX}\n${command}` : command;
}

// exec-ing through "$@" keeps the original argv untouched by shell quoting and
// guarantees the tag lands before the target can run or fork.
export function tagInvocation(
	command: string,
	args: string[],
): { command: string; args: string[] } {
	if (!LINUX) return { command, args };
	return {
		command: "/bin/sh",
		args: [
			"-c",
			`${SACRIFICE_COMMAND_PREFIX}; exec "$@"`,
			"sh",
			command,
			...args,
		],
	};
}

const JOURNAL_TIMEOUT_MS = 1_500;
const JOURNAL_MAX_BYTES = 256 * 1024;

export function earlyoomKillSince(sinceEpochMs: number): boolean {
	if (!LINUX) return false;
	try {
		const log = execFileSync(
			"journalctl",
			[
				"-u",
				"earlyoom",
				"--since",
				`@${Math.floor(sinceEpochMs / 1000)}`,
				"-o",
				"cat",
				"--no-pager",
				"-q",
			],
			{
				timeout: JOURNAL_TIMEOUT_MS,
				maxBuffer: JOURNAL_MAX_BYTES,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		return /sending SIG(TERM|KILL) to process/.test(log);
	} catch {
		return false;
	}
}

// Post-mortem pid correlation is impossible (the process tree is gone), so a
// journal-confirmed kill inside the window yields a "likely" diagnosis, not a fact.
export function sacrificeKillNote(
	death: { exitCode: number | undefined; signal: string | undefined },
	sinceEpochMs: number,
): string | undefined {
	const signalish =
		death.signal === "SIGTERM" ||
		death.signal === "SIGKILL" ||
		death.exitCode === 137 ||
		death.exitCode === 143;
	if (!signalish || !earlyoomKillSince(sinceEpochMs)) return undefined;
	return "likely killed by earlyoom under system memory pressure; pi-spawned work dies before the session";
}
