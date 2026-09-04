#!/usr/bin/env node

import { writeSync } from "node:fs";

const channel = process.env.PI_BACKGROUND_TERMINAL_NOTIFY_FD;
if (!channel) {
	process.stderr.write(
		"emit-to-pi is available only inside a Pi-owned background terminal.\n",
	);
	process.exit(1);
}

const fd = Number(channel);
const message = process.argv.slice(2).join(" ").trim();
if (!Number.isInteger(fd) || fd < 3) {
	process.stderr.write(
		"emit-to-pi received an invalid notification channel.\n",
	);
	process.exit(1);
}
if (!message) {
	process.stderr.write("usage: emit-to-pi <message>\n");
	process.exit(1);
}

const frame = `${JSON.stringify({ version: 1, message })}\n`;
if (Buffer.byteLength(frame) > 4 * 1024) {
	process.stderr.write("emit-to-pi messages must fit within 4 KiB.\n");
	process.exit(1);
}

try {
	writeSync(fd, frame);
} catch (error) {
	const detail = error instanceof Error ? error.message : String(error);
	process.stderr.write(`emit-to-pi could not reach Pi: ${detail}\n`);
	process.exit(1);
}
