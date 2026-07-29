import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateUtf8Window } from "../../lib/text.ts";

const COLLECT_CHANNEL = "process-status:collect";
const MAX_SOURCES = 16;
export const MAX_ACTIVITIES_PER_SOURCE = 192;
const MAX_ACTIVITIES_PER_KIND = 64;
const MAX_SUMMARY_CHARACTERS = 240;
const MAX_DETAIL_BYTES = 64 * 1024;

export type ProcessStatusKind = "subagents" | "terminals";

export interface ProcessStatusUsage {
	tokens: number;
	cost: number;
}

export interface ProcessStatusActivity {
	id: string;
	kind: ProcessStatusKind;
	active: boolean;
	summary: string;
	usage?: ProcessStatusUsage;
	detail?: () => string;
}

export interface ProcessStatusView {
	collapsed: string;
	expanded: string;
	list: boolean;
}

type ProcessStatusSource = () => readonly ProcessStatusActivity[];
type ProcessStatusUsageSource = () => ProcessStatusUsage;

interface CollectionRequest {
	add(
		name: string,
		load: ProcessStatusSource,
		loadUsage?: ProcessStatusUsageSource,
	): void;
}

function sanitize(text: string): string {
	let sanitized = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		sanitized +=
			(code === 9 || code === 10 || code >= 32) &&
			code !== 127 &&
			!/\p{Cf}/u.test(character)
				? character
				: "�";
	}
	return sanitized;
}

function inline(text: string): string {
	return [...sanitize(text).replace(/\s+/gu, " ").trim()]
		.slice(0, MAX_SUMMARY_CHARACTERS)
		.join("");
}

function boundedDetail(text: string): string {
	return truncateUtf8Window(
		sanitize(text).trim(),
		MAX_DETAIL_BYTES,
		8 * 1024,
		"\n\n[truncated]\n\n",
	);
}

function validUsage(usage: ProcessStatusUsage): boolean {
	return (
		Number.isFinite(usage.tokens) &&
		usage.tokens >= 0 &&
		Number.isFinite(usage.cost) &&
		usage.cost >= 0
	);
}

export function registerProcessStatusSource(
	pi: Pick<ExtensionAPI, "events">,
	name: string,
	load: ProcessStatusSource,
	loadUsage?: ProcessStatusUsageSource,
): () => void {
	return pi.events.on(COLLECT_CHANNEL, (data) => {
		const request = data as Partial<CollectionRequest> | undefined;
		if (typeof request?.add !== "function") return;
		request.add(name, load, loadUsage);
	});
}

function collect(pi: Pick<ExtensionAPI, "events">, includeActivities = true) {
	const groups: Record<ProcessStatusKind, ProcessStatusActivity[]> = {
		subagents: [],
		terminals: [],
	};
	const omitted: Record<ProcessStatusKind, number> = {
		subagents: 0,
		terminals: 0,
	};
	const usage: ProcessStatusUsage = { tokens: 0, cost: 0 };
	const errors: string[] = [];
	const ids = new Set<string>();
	let sourceCount = 0;
	let omittedSources = 0;
	const activeRequests = new WeakSet<CollectionRequest>();
	const request: CollectionRequest = {
		add(
			name: string,
			load: ProcessStatusSource,
			loadUsage?: ProcessStatusUsageSource,
		) {
			if (!activeRequests.has(request)) return;
			sourceCount += 1;
			if (sourceCount > MAX_SOURCES) {
				omittedSources += 1;
				return;
			}
			try {
				if (loadUsage) {
					const sourceUsage = loadUsage();
					if (!validUsage(sourceUsage)) throw new Error("invalid usage");
					usage.tokens += sourceUsage.tokens;
					usage.cost += sourceUsage.cost;
				}
				if (!includeActivities) return;
				const activities = load();
				if (activities.length > MAX_ACTIVITIES_PER_SOURCE) {
					throw new Error(
						`limit=activities count=${activities.length} max=${MAX_ACTIVITIES_PER_SOURCE}`,
					);
				}
				for (const activity of activities) {
					if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(activity.id)) {
						errors.push(`${inline(name)}: error=invalid-id`);
						continue;
					}
					if (ids.has(activity.id)) {
						errors.push(
							`${inline(name)}: error=duplicate-id id=${activity.id}`,
						);
						continue;
					}
					if (activity.usage && !validUsage(activity.usage)) {
						errors.push(
							`${inline(name)}: error=invalid-usage id=${activity.id}`,
						);
						continue;
					}
					ids.add(activity.id);
					const entries = groups[activity.kind];
					if (entries.length < MAX_ACTIVITIES_PER_KIND) {
						entries.push(activity);
						continue;
					}
					omitted[activity.kind] += 1;
					if (activity.active) {
						const inactive = entries.findIndex((entry) => !entry.active);
						if (inactive >= 0) entries.splice(inactive, 1, activity);
					}
				}
			} catch (error) {
				errors.push(
					inline(
						`${name}: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
			}
		},
	};
	activeRequests.add(request);
	pi.events.emit(COLLECT_CHANNEL, request);
	activeRequests.delete(request);

	return { groups, omitted, usage, errors, omittedSources };
}

function usageText(usage: ProcessStatusUsage): string {
	return `${usage.tokens.toLocaleString("en-US")} tokens · $${usage.cost.toFixed(4)}`;
}

function listText(
	collection: ReturnType<typeof collect>,
	expanded: boolean,
): string {
	const entries = Object.values(collection.groups)
		.flat()
		.filter((activity) => expanded || activity.active)
		.map(
			(activity) =>
				`${activity.id} ${inline(activity.summary) || "summary=none"}`,
		);
	const omitted = Object.values(collection.omitted).reduce(
		(total, count) => total + count,
		collection.omittedSources,
	);
	if (omitted > 0) entries.push(`${omitted} omitted`);
	entries.push(...collection.errors.map((error) => `error: ${error}`));
	const usage = usageText(collection.usage);
	return entries.length > 0
		? [usage, ...entries].join("\n")
		: `${usage} · idle`;
}

export function processStatusCost(pi: Pick<ExtensionAPI, "events">): number {
	return collect(pi, false).usage.cost;
}

export function processStatusView(
	pi: Pick<ExtensionAPI, "events">,
	requestedId?: string,
): ProcessStatusView {
	const collection = collect(pi);
	if (!requestedId) {
		return {
			collapsed: listText(collection, false),
			expanded: listText(collection, true),
			list: true,
		};
	}

	const id = inline(requestedId).slice(0, 64);
	const activity = Object.values(collection.groups)
		.flat()
		.find((candidate) => candidate.id === requestedId);
	if (!activity) {
		const text = `error: unknown-id · id: ${id} · action: /ps`;
		return { collapsed: text, expanded: text, list: false };
	}

	let detail = "";
	try {
		if (activity.detail) detail = boundedDetail(activity.detail());
	} catch (error) {
		detail = `detail-error: ${inline(error instanceof Error ? error.message : String(error))}`;
	}
	const text = `${activity.usage ? `${usageText(activity.usage)} · ` : ""}${activity.id} ${inline(activity.summary) || "summary=none"}${detail ? `\n\n${detail}` : ""}`;
	return { collapsed: text, expanded: text, list: false };
}
