import type { AssistantMessage } from "@earendil-works/pi-ai";

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

/** Streaming text parts append in place; message_end is authoritative. */
export class StreamingPreview {
	private readonly parts = new Map<number, TextPart>();

	capture(message: AssistantMessage) {
		let text = "";
		let progress = "";
		for (const [index, part] of message.content.entries()) {
			if (part.type !== "text") continue;
			const end = completeEnd(part.text, part.text.length);
			let cached = this.parts.get(index);
			if (!cached || end < cached.consumed) {
				cached = { consumed: 0, start: undefined, end: 0, progress: "" };
				this.parts.set(index, cached);
			}
			const delta = part.text.slice(cached.consumed, end);
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
			if (cached.start === undefined) continue;
			const excerpt = edges(part.text, cached.start, cached.end);
			text = edges(text ? `${text}\n${excerpt}` : excerpt);
			if (progress.length < PROGRESS_UNITS) {
				progress = `${progress ? `${progress} ` : ""}${cached.progress.trim()}`;
				progress = progress.slice(
					0,
					completeEnd(progress, Math.min(progress.length, PROGRESS_UNITS)),
				);
			}
		}
		return { text, progress };
	}
}
