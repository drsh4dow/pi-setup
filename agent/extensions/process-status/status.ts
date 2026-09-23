import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Predicate, Schema } from "effect";
import { sanitizeInline, truncateUtf8Window } from "../../lib/text.ts";
import {
	formatTerminalDetails,
	summary,
} from "../background-terminals/delivery.ts";
import type { BackgroundTerminalManager } from "../background-terminals/manager.ts";

const TERMINALS_CHANNEL = "process-status:terminals";

const REFRESH_CHANNEL = "process-status:refresh";

const MAX_DETAIL_BYTES = 64 * 1024;

type TerminalStatus = Pick<BackgroundTerminalManager, "list" | "get">;

export interface ProcessStatusView {
	collapsed: string;
	expanded: string;
	list: boolean;
}

interface TerminalStatusRequest {
	readonly provide: (terminals: TerminalStatus) => void;
}

// Each extension loads its own module copy, so requests use a structural contract.
const isTerminalStatusRequest = Schema.is(
	Schema.Struct({
		provide: Schema.declare(
			(value): value is TerminalStatusRequest["provide"] =>
				Predicate.isFunction(value),
		),
	}),
);

export function requestProcessStatusRefresh(
	pi: Pick<ExtensionAPI, "events">,
): void {
	pi.events.emit(REFRESH_CHANNEL, undefined);
}

export function observeProcessStatusRefresh(
	pi: Pick<ExtensionAPI, "events">,
	refresh: () => void,
): () => void {
	return pi.events.on(REFRESH_CHANNEL, refresh);
}

export function registerBackgroundTerminalStatus(
	pi: Pick<ExtensionAPI, "events">,
	terminals: TerminalStatus,
): () => void {
	return pi.events.on(TERMINALS_CHANNEL, (request) => {
		if (isTerminalStatusRequest(request)) request.provide(terminals);
	});
}

function backgroundTerminals(pi: Pick<ExtensionAPI, "events">) {
	let terminals: TerminalStatus | undefined;

	const request: TerminalStatusRequest = {
		provide: (value) => {
			terminals = value;
		},
	};

	pi.events.emit(TERMINALS_CHANNEL, request);

	return terminals;
}

export function processStatusSummary(
	pi: Pick<ExtensionAPI, "events">,
): string | undefined {
	const count =
		backgroundTerminals(pi)
			?.list()
			.filter((terminal) => terminal.state === "running").length ?? 0;

	return count > 0 ? `${count} bg` : undefined;
}

export function processStatusView(
	pi: Pick<ExtensionAPI, "events">,
	requestedId?: string,
): ProcessStatusView {
	const terminals = backgroundTerminals(pi);

	if (!requestedId) {
		const active: string[] = [];
		const tracked: string[] = [];

		for (const terminal of terminals?.list() ?? []) {
			const text = summary(terminal);
			tracked.push(text);

			if (terminal.state === "running") active.push(text);
		}

		return {
			collapsed: active.join("\n") || "idle",
			expanded: tracked.join("\n") || "idle",
			list: true,
		};
	}

	const id = sanitizeInline(requestedId).trim().slice(0, 64);
	const terminal = terminals?.get(id);

	if (!terminal) {
		const text = `error: unknown-id · id: ${id} · action: /ps`;

		return { collapsed: text, expanded: text, list: false };
	}

	const detail = truncateUtf8Window(
		formatTerminalDetails(terminal).trim(),
		MAX_DETAIL_BYTES,
		8 * 1024,
		"\n\n[truncated]\n\n",
	);

	const text = `${summary(terminal)}\n\n${detail}`;

	return { collapsed: text, expanded: text, list: false };
}
