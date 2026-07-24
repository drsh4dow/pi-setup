import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateUtf8Window } from "../../lib/text.ts";

const COLLECT_CHANNEL = "process-status:collect";
const MAX_SOURCES = 16;
const MAX_ACTIVITIES_PER_SOURCE = 192;
const MAX_ACTIVITIES_PER_KIND = 64;
const MAX_SUMMARY_CHARACTERS = 240;
const MAX_DETAIL_BYTES = 64 * 1024;

export type ProcessStatusKind = "subagents" | "workflows" | "terminals";

export interface ProcessStatusActivity {
  id: string;
  kind: ProcessStatusKind;
  active: boolean;
  summary: string;
  detail: () => string;
}

export interface ProcessStatusView {
  collapsed: string;
  expanded: string;
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
  const groups: Record<ProcessStatusKind, ProcessStatusActivity[]> = {
    subagents: [],
    workflows: [],
    terminals: [],
  };
  const omitted: Record<ProcessStatusKind, number> = {
    subagents: 0,
    workflows: 0,
    terminals: 0,
  };
  const errors: string[] = [];
  const ids = new Set<string>();
  let sourceCount = 0;
  let omittedSources = 0;
  let accepting = true;

  pi.events.emit(COLLECT_CHANNEL, {
    add(name: string, load: ProcessStatusSource) {
      if (!accepting) return;
      sourceCount += 1;
      if (sourceCount > MAX_SOURCES) {
        omittedSources += 1;
        return;
      }
      try {
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
  } satisfies CollectionRequest);
  accepting = false;

  return { groups, omitted, errors, omittedSources };
}

function listText(
  collection: ReturnType<typeof collect>,
  expanded: boolean,
): string {
  const sections = (
    [
      ["subagents", "subagents"],
      ["workflows", "workflows"],
      ["terminals", "terminals"],
    ] as const
  ).map(([title, kind]) => {
    const entries = collection.groups[kind]
      .filter((activity) => expanded || activity.active)
      .map(
        (activity) =>
          `  ${activity.id} ${inline(activity.summary) || "summary=none"}`,
      );
    if (collection.omitted[kind] > 0) {
      entries.push(`  omitted: ${collection.omitted[kind]}`);
    }
    return `${title}:\n${entries.length > 0 ? entries.join("\n") : "  -"}`;
  });
  if (collection.errors.length > 0) {
    sections.push(
      `errors:\n${collection.errors.map((error) => `  ${error}`).join("\n")}`,
    );
  }
  if (collection.omittedSources > 0) {
    sections.push(`sources:\n  omitted: ${collection.omittedSources}`);
  }
  return sections.join("\n\n");
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
    };
  }

  const id = inline(requestedId).slice(0, 64);
  const activity = Object.values(collection.groups)
    .flat()
    .find((candidate) => candidate.id === requestedId);
  if (!activity) {
    const text = `error: unknown-id\nid: ${id}\naction: /ps`;
    return { collapsed: text, expanded: text };
  }

  let detail: string;
  try {
    detail = boundedDetail(activity.detail());
  } catch (error) {
    detail = `detail-error: ${inline(error instanceof Error ? error.message : String(error))}`;
  }
  const text = `${activity.id} ${inline(activity.summary) || "summary=none"}${detail ? `\n\n${detail}` : ""}`;
  return { collapsed: text, expanded: text };
}
