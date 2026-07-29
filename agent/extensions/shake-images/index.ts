import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ContextEvent,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];
type ImageBlock = { type: "image"; data: string; mimeType: string };
type MaterializeImage = (image: ImageBlock) => Promise<string>;

interface ContentBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

function contentOf(message: AgentMessage): unknown[] | undefined {
	return "content" in message && Array.isArray(message.content)
		? message.content
		: undefined;
}

function isContentBlock(block: unknown): block is ContentBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		"type" in block &&
		typeof block.type === "string"
	);
}

function imagePathsInText(text: string): string[] {
	const matches = [
		...text.matchAll(/<file name="([^"]+)">([\s\S]*?)<\/file>/g),
	];
	return matches
		.filter(
			(match) =>
				/\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(match[1] ?? "") ||
				!(match[2] ?? "").startsWith("\n"),
		)
		.map((match) => match[1])
		.filter((path): path is string => path !== undefined);
}

function readToolPaths(
	messages: ContextEvent["messages"],
): Map<string, string> {
	const paths = new Map<string, string>();
	for (const message of messages) {
		for (const block of contentOf(message) ?? []) {
			if (
				!isContentBlock(block) ||
				block.type !== "toolCall" ||
				block.name !== "read"
			)
				continue;
			const args = block.arguments;
			if (typeof args !== "object" || args === null) continue;
			const path =
				"path" in args
					? args.path
					: "file_path" in args
						? args.file_path
						: undefined;
			if (typeof block.id === "string" && typeof path === "string") {
				paths.set(block.id, path);
			}
		}
	}
	return paths;
}

function sourcePathsForMessage(
	message: AgentMessage,
	toolPaths: Map<string, string>,
): string[] {
	const content = contentOf(message) ?? [];
	if (message.role === "toolResult") {
		const path = toolPaths.get(message.toolCallId);
		if (path)
			return content
				.filter((block) => isContentBlock(block) && block.type === "image")
				.map(() => path);
	}

	return content.flatMap((block) =>
		isContentBlock(block) &&
		block.type === "text" &&
		typeof block.text === "string"
			? imagePathsInText(block.text)
			: [],
	);
}

export async function pruneImages(
	messages: ContextEvent["messages"],
	materializeImage: MaterializeImage,
): Promise<ContextEvent["messages"]> {
	let imageCount = 0;
	for (const message of messages) {
		for (const block of contentOf(message) ?? []) {
			if (isContentBlock(block) && block.type === "image") imageCount++;
		}
	}

	let imagesToPrune = imageCount - 2;
	if (imagesToPrune <= 0) return messages;

	const toolPaths = readToolPaths(messages);
	const transformed: ContextEvent["messages"] = [];

	for (const message of messages) {
		const content = contentOf(message);
		if (!content) {
			transformed.push(message);
			continue;
		}

		const sourcePaths = sourcePathsForMessage(message, toolPaths);
		let imageIndex = 0;
		let changed = false;
		const nextContent: unknown[] = [];

		for (const block of content) {
			if (
				!isContentBlock(block) ||
				block.type !== "image" ||
				imagesToPrune <= 0
			) {
				nextContent.push(block);
				continue;
			}

			const image = block as ImageBlock;
			const path = sourcePaths[imageIndex] ?? (await materializeImage(image));
			imageIndex++;
			imagesToPrune--;
			changed = true;
			nextContent.push({ type: "text", text: `Image: ${path}` });
		}

		transformed.push(
			changed
				? ({ ...message, content: nextContent } as unknown as AgentMessage)
				: message,
		);
	}

	return transformed;
}

export default function shakeImagesExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let tempImagesDir: Promise<string> | undefined;

	const materializeImage: MaterializeImage = async (image) => {
		tempImagesDir ??= mkdtemp(join(tmpdir(), "pi-shake-images-"));
		let directory: string;
		try {
			directory = await tempImagesDir;
		} catch (error) {
			tempImagesDir = undefined;
			throw error;
		}

		const extension =
			{
				"image/avif": "avif",
				"image/bmp": "bmp",
				"image/gif": "gif",
				"image/jpeg": "jpg",
				"image/png": "png",
				"image/webp": "webp",
			}[image.mimeType] ?? "img";
		const path = join(
			directory,
			`${createHash("sha256").update(image.data).digest("hex")}.${extension}`,
		);
		try {
			await writeFile(path, Buffer.from(image.data, "base64"), { flag: "wx" });
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "EEXIST")
			)
				throw error;
		}
		return path;
	};

	pi.registerCommand("shake-images", {
		description: "Keep only the latest two images in model context",
		handler: async (_args, ctx) => {
			enabled = true;
			ctx.ui.notify("Image context pruned to the latest two images", "info");
		},
	});

	pi.on("context", async (event) => {
		if (!enabled) return undefined;
		return { messages: await pruneImages(event.messages, materializeImage) };
	});

	pi.on("session_shutdown", async () => {
		if (!tempImagesDir) return;
		const directory = await tempImagesDir;
		tempImagesDir = undefined;
		await rm(directory, { force: true, recursive: true });
	});
}
