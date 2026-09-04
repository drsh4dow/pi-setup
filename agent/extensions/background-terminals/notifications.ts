import { Schema } from "effect";

const { delimiter } = process.getBuiltinModule("node:path");
const { fileURLToPath } = process.getBuiltinModule("node:url");
const processEnvironment = process.getBuiltinModule("node:process").env;

export const NOTIFICATION_FD = 3;
const MAX_NOTIFICATION_FRAME_BYTES = 4 * 1024;
const notificationBin = fileURLToPath(new URL("./bin", import.meta.url));
const NotificationWire = Schema.fromJsonString(
	Schema.Struct({ version: Schema.Literal(1), message: Schema.NonEmptyString }),
);

type FrameState =
	| { kind: "collecting"; buffered: Buffer }
	| { kind: "dropping-oversized" };

export interface RunningTerminalNotification {
	id: string;
	terminalId: string;
	title: string;
	cwd: string;
	message: string;
	createdAt: number;
}

export function notificationEnvironment(): NodeJS.ProcessEnv {
	return {
		...processEnvironment,
		PATH: [notificationBin, processEnvironment.PATH]
			.filter((entry): entry is string => Boolean(entry))
			.join(delimiter),
		PI_BACKGROUND_TERMINAL_NOTIFY_FD: String(NOTIFICATION_FD),
	};
}

export class NotificationFrames {
	private state: FrameState = {
		kind: "collecting",
		buffered: Buffer.alloc(0),
	};

	append(chunk: Buffer): string[] {
		let input = chunk;
		if (this.state.kind === "dropping-oversized") {
			const newline = input.indexOf(10);
			if (newline === -1) return [];
			this.state = { kind: "collecting", buffered: Buffer.alloc(0) };
			input = input.subarray(newline + 1);
		}
		let buffered = Buffer.concat([this.state.buffered, input]);
		const messages: string[] = [];
		for (;;) {
			const newline = buffered.indexOf(10);
			if (newline === -1) break;
			const frame = buffered.subarray(0, newline);
			buffered = buffered.subarray(newline + 1);
			if (frame.length > MAX_NOTIFICATION_FRAME_BYTES) continue;
			try {
				messages.push(
					Schema.decodeSync(NotificationWire)(frame.toString("utf8")).message,
				);
			} catch {
				// Only emit-to-pi frames are accepted on the private channel.
			}
		}
		this.state =
			buffered.length > MAX_NOTIFICATION_FRAME_BYTES
				? { kind: "dropping-oversized" }
				: { kind: "collecting", buffered };
		return messages;
	}
}
