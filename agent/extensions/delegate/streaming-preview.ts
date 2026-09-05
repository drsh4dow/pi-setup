import type {
	AssistantMessage,
	AssistantMessageEvent,
} from "@earendil-works/pi-ai";

interface TextPart {
	consumed: number;
	start: number | undefined;
	end: number;
	progress: string;
}

// Keep more UTF-16 units than either UTF-8 budget can display. The final byte
// truncation still owns the exact head/tail split and truncation marker.
export const MAX_MESSAGE_BYTES = 4 * 1024;
export const MAX_PROGRESS_BYTES = 240;
const EDGE_UNITS = MAX_MESSAGE_BYTES;
const PROGRESS_UNITS = MAX_PROGRESS_BYTES + 4;

function completeEnd(text: string, end: number) {
	const code = text.charCodeAt(end - 1);
	return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

function edges(text: string, start = 0, end = text.length) {
	if (end - start <= EDGE_UNITS * 2) return text.slice(start, end);
	const headEnd = completeEnd(text, start + EDGE_UNITS);
	let tailStart = end - EDGE_UNITS;
	const code = text.charCodeAt(tailStart);
	if (code >= 0xdc00 && code <= 0xdfff) tailStart++;
	return text.slice(start, headEnd) + text.slice(tailStart, end);
}

interface Preview {
	text: string;
	progress: string;
}

function combine(left: Preview, right: Preview): Preview {
	const progress = [left.progress, right.progress].filter(Boolean).join(" ");
	return {
		text: edges(
			left.text && right.text
				? `${left.text}\n${right.text}`
				: left.text || right.text,
		),
		progress: progress.slice(
			0,
			completeEnd(progress, Math.min(progress.length, PROGRESS_UNITS)),
		),
	};
}

/** One bounded prefix and one incremental block, never one cache per index.
 * SDK text events carry indexed snapshots; Responses slots can interleave and
 * text_end can replace text. Earlier-index updates rebuild rather than losing
 * evicted parts. Ordered appends only visit the current/new content blocks.
 */
export class StreamingPreview {
	private index = -1;
	private part: TextPart = {
		consumed: 0,
		start: undefined,
		end: 0,
		progress: "",
	};
	private prefix: Preview = { text: "", progress: "" };
	private current: Preview = { text: "", progress: "" };

	capture(message: AssistantMessage, event?: AssistantMessageEvent): Preview {
		if (
			event &&
			event.type !== "text_start" &&
			event.type !== "text_delta" &&
			event.type !== "text_end"
		) {
			return combine(this.prefix, this.current);
		}
		const target = event?.contentIndex ?? message.content.length - 1;
		if (target < this.index) {
			this.index = -1;
			this.prefix = { text: "", progress: "" };
			this.current = { text: "", progress: "" };
		}
		// Include later active slots when rebuilding an interleaved snapshot.
		const endIndex = Math.max(target, message.content.length - 1);
		for (let index = Math.max(0, this.index); index <= endIndex; index++) {
			const block = message.content[index];
			if (block?.type !== "text") continue;
			if (index !== this.index) {
				this.prefix = combine(this.prefix, this.current);
				this.current = { text: "", progress: "" };
				this.part = { consumed: 0, start: undefined, end: 0, progress: "" };
				this.index = index;
			}
			const end = completeEnd(block.text, block.text.length);
			if (
				end < this.part.consumed ||
				(event?.type === "text_end" && index === target)
			) {
				this.part = { consumed: 0, start: undefined, end: 0, progress: "" };
			}
			const cached = this.part;
			const delta = block.text.slice(cached.consumed, end);
			if (cached.start === undefined) {
				const first = delta.search(/\S/u);
				if (first !== -1) cached.start = cached.consumed + first;
			}
			const trimmedEnd = delta.trimEnd().length;
			if (trimmedEnd) cached.end = cached.consumed + trimmedEnd;
			if (cached.progress.length < PROGRESS_UNITS) {
				const normalized = (cached.progress + delta)
					.replace(/\s+/gu, " ")
					.trimStart();
				cached.progress = normalized.slice(
					0,
					completeEnd(normalized, Math.min(normalized.length, PROGRESS_UNITS)),
				);
			}
			cached.consumed = end;
			this.current =
				cached.start === undefined
					? { text: "", progress: "" }
					: {
							text: edges(block.text, cached.start, cached.end),
							progress: cached.progress.trim(),
						};
		}
		return combine(this.prefix, this.current);
	}
}
