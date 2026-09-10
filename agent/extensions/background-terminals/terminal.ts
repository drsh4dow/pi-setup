export const RETAINED_BYTES = 256 * 1024;

interface OutputTail {
	text: string;
	totalBytes: number;
	truncatedBytes: number;
}

interface TerminalSnapshotBase {
	id: string;
	command: string;
	title: string;
	cwd: string;
	pid?: number;
	createdAt: number;
	stdout: OutputTail;
	stderr: OutputTail;
}

declare const NonZeroExitCodeType: unique symbol;

type NonZeroExitCode = number & {
	readonly [NonZeroExitCodeType]: "NonZeroExitCode";
};

export type ProcessExit =
	| { kind: "success" }
	| { kind: "nonzero-exit"; code: NonZeroExitCode }
	| { kind: "signal"; signal: string }
	| { kind: "unknown" };

type NonSuccessProcessExit = Exclude<ProcessExit, { kind: "success" }>;

function makeNonZeroExitCode(code: number): NonZeroExitCode {
	if (!Number.isInteger(code) || code === 0)
		throw new Error(`Expected a nonzero integer exit code, received ${code}.`);

	// SAFETY: the checks above establish the branded nonzero integer invariant.
	return code as NonZeroExitCode;
}

export type RunningTerminalSnapshot = TerminalSnapshotBase & {
	state: "running";
	settledAt?: never;
	process:
		| { kind: "executing"; error?: string }
		| { kind: "observed-exit"; exit: ProcessExit; error?: string };
};

export type SettledTerminalSnapshot =
	| (TerminalSnapshotBase & {
			state: "done";
			settledAt: number;
			result: { kind: "success" };
	  })
	| (TerminalSnapshotBase & {
			state: "failed";
			settledAt: number;
			result:
				| { kind: "process-failure"; exit: NonSuccessProcessExit }
				| { kind: "error"; error: string; exit: ProcessExit };
	  })
	| (TerminalSnapshotBase & {
			state: "killed";
			settledAt: number;
			result: { kind: "killed"; exit: ProcessExit; error?: string };
	  });

export type TerminalSnapshot =
	| RunningTerminalSnapshot
	| SettledTerminalSnapshot;

type WithoutOutputText<T> = T extends TerminalSnapshot
	? Omit<T, "stdout" | "stderr"> & {
			stdout: Omit<OutputTail, "text">;
			stderr: Omit<OutputTail, "text">;
		}
	: never;

export type TerminalMetadata = WithoutOutputText<TerminalSnapshot>;

export type RunningTerminalMetadata =
	WithoutOutputText<RunningTerminalSnapshot>;

export interface TerminalResultFields {
	exitCode: number | undefined;
	signal: string | undefined;
	error: string | undefined;
}

export class Tail {
	private chunks: Buffer[] = [];
	private headOffset = 0;
	private retainedBytes = 0;
	totalBytes = 0;
	append(chunk: Buffer) {
		this.totalBytes += chunk.length;

		if (chunk.length >= RETAINED_BYTES) {
			let start = chunk.length - RETAINED_BYTES;

			while (start < chunk.length && (chunk[start] & 0xc0) === 0x80) start++;
			const retained = Buffer.from(chunk.subarray(start));
			this.chunks = retained.length ? [retained] : [];
			this.headOffset = 0;
			this.retainedBytes = retained.length;

			return;
		}

		this.chunks.push(chunk);
		this.retainedBytes += chunk.length;
		let discard = Math.max(0, this.retainedBytes - RETAINED_BYTES);

		while (discard > 0) {
			const available = this.chunks[0].length - this.headOffset;

			if (discard < available) {
				this.headOffset += discard;
				this.retainedBytes -= discard;
				discard = 0;
			} else {
				discard -= available;
				this.retainedBytes -= available;
				this.chunks.shift();
				this.headOffset = 0;
			}
		}

		while (
			this.retainedBytes > 0 &&
			(this.chunks[0][this.headOffset] & 0xc0) === 0x80
		) {
			this.headOffset++;
			this.retainedBytes--;

			if (this.headOffset === this.chunks[0].length) {
				this.chunks.shift();
				this.headOffset = 0;
			}
		}

		if (this.chunks.length > 128) {
			this.chunks = [this.buffer()];
			this.headOffset = 0;
		}
	}
	private buffer(): Buffer {
		if (this.chunks.length === 0) return Buffer.alloc(0);

		if (this.chunks.length === 1)
			return this.chunks[0].subarray(this.headOffset);

		return Buffer.concat([
			this.chunks[0].subarray(this.headOffset),
			...this.chunks.slice(1),
		]);
	}
	metadata(): Omit<OutputTail, "text"> {
		return {
			totalBytes: this.totalBytes,
			truncatedBytes: this.totalBytes - this.retainedBytes,
		};
	}
	view(): OutputTail {
		return { ...this.metadata(), text: this.buffer().toString("utf8") };
	}
}

export function assertNever(value: never): never {
	throw new Error(`Unexpected terminal lifecycle variant: ${String(value)}`);
}

export function processExit(
	code: number | null,
	signal: NodeJS.Signals | null,
): ProcessExit {
	if (signal !== null) return { kind: "signal", signal };

	if (code === 0) return { kind: "success" };

	if (code !== null)
		return { kind: "nonzero-exit", code: makeNonZeroExitCode(code) };

	return { kind: "unknown" };
}

export function processExitFields(
	exit: ProcessExit,
): Omit<TerminalResultFields, "error"> {
	switch (exit.kind) {
		case "success":
			return { exitCode: 0, signal: undefined };
		case "nonzero-exit":
			return { exitCode: exit.code, signal: undefined };
		case "signal":
			return { exitCode: undefined, signal: exit.signal };
		case "unknown":
			return { exitCode: undefined, signal: undefined };
		default:
			return assertNever(exit);
	}
}

function snapshotExit(snapshot: TerminalMetadata): ProcessExit | undefined {
	if (snapshot.state === "running")
		return snapshot.process.kind === "executing"
			? undefined
			: snapshot.process.exit;

	switch (snapshot.state) {
		case "done":
			return { kind: "success" };
		case "failed":
			return snapshot.result.exit;
		case "killed":
			return snapshot.result.exit;
		default:
			return assertNever(snapshot);
	}
}

function snapshotError(snapshot: TerminalMetadata): string | undefined {
	switch (snapshot.state) {
		case "running":
			return snapshot.process.error;
		case "done":
			return undefined;
		case "failed":
			switch (snapshot.result.kind) {
				case "process-failure":
					return undefined;
				case "error":
					return snapshot.result.error;
				default:
					return assertNever(snapshot.result);
			}

		case "killed":
			return snapshot.result.error;
		default:
			return assertNever(snapshot);
	}
}

export function terminalResultFields(
	snapshot: TerminalMetadata,
): TerminalResultFields {
	const exit = snapshotExit(snapshot);

	return {
		...(exit
			? processExitFields(exit)
			: { exitCode: undefined, signal: undefined }),
		error: snapshotError(snapshot),
	};
}
