import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateUtf8Window } from "../../lib/text.ts";

const COLLECT_CHANNEL = "process-status:collect";
const REFRESH_CHANNEL = "process-status:refresh";
const MAX_SOURCES = 16;
export const MAX_ACTIVITIES_PER_SOURCE = 192;
const MAX_ACTIVITIES = 64;
const MAX_SUMMARY_CHARACTERS = 240;
const MAX_DETAIL_BYTES = 64 * 1024;

interface ProcessStatusActivity {
	id: string;
	active: boolean;
	summary: string;
	detail?: () => string;
}

export interface ProcessStatusView {
	collapsed: string;
	expanded: string;
	list: boolean;
}

type ProcessStatusSource = () => readonly ProcessStatusActivity[];

interface CollectionRequest {
	add(name: string, load: ProcessStatusSource): void;
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

export function registerProcessStatusSource(
	pi: Pick<ExtensionAPI, "events">,
	name: string,
	load: ProcessStatusSource,
): () => void {
	return pi.events.on(COLLECT_CHANNEL, (data) => {
		const request = data as Partial<CollectionRequest> | undefined;
		if (typeof request?.add !== "function") return;
		request.add(name, load);
	});
}

function collect(pi: Pick<ExtensionAPI, "events">) {
	const activities: ProcessStatusActivity[] = [];
	const errors: string[] = [];
	const ids = new Set<string>();
	let sourceCount = 0;
	let omitted = 0;
	const closedRequests = new WeakSet<CollectionRequest>();
	const request: CollectionRequest = {
		add(name, load) {
			if (closedRequests.has(request)) return;
			if (++sourceCount > MAX_SOURCES) {
				omitted++;
				return;
			}
			try {
				const sourceActivities = load();
				if (sourceActivities.length > MAX_ACTIVITIES_PER_SOURCE) {
					throw new Error(
						`limit=activities count=${sourceActivities.length} max=${MAX_ACTIVITIES_PER_SOURCE}`,
					);
				}
				for (const activity of sourceActivities) {
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
					ids.add(activity.id);
					if (activities.length < MAX_ACTIVITIES) {
						activities.push(activity);
						continue;
					}
					omitted++;
					if (activity.active) {
						const inactive = activities.findIndex((entry) => !entry.active);
						if (inactive >= 0) activities.splice(inactive, 1, activity);
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
	pi.events.emit(COLLECT_CHANNEL, request);
	closedRequests.add(request);
	return { activities, errors, omitted };
}

function listText(
	collection: ReturnType<typeof collect>,
	expanded: boolean,
): string {
	const entries = collection.activities
		.filter((activity) => expanded || activity.active)
		.map(
			(activity) =>
				`${activity.id} ${inline(activity.summary) || "summary=none"}`,
		);
	if (collection.omitted > 0) entries.push(`${collection.omitted} omitted`);
	entries.push(...collection.errors.map((error) => `error: ${error}`));
	return entries.length > 0 ? entries.join("\n") : "idle";
}

export function processStatusSummary(
	pi: Pick<ExtensionAPI, "events">,
): string | undefined {
	const count = collect(pi).activities.filter(
		(activity) => activity.active,
	).length;
	return count > 0 ? `${count} bg` : undefined;
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
	const activity = collection.activities.find(
		(candidate) => candidate.id === requestedId,
	);
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
	const text = `${activity.id} ${inline(activity.summary) || "summary=none"}${detail ? `\n\n${detail}` : ""}`;
	return { collapsed: text, expanded: text, list: false };
}
