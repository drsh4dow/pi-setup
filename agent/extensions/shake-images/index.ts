import type {
	ContextEvent,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
	Crypto,
	Duration,
	Effect,
	Encoding,
	FileSystem,
	Layer,
	ManagedRuntime,
	Path,
	Result,
} from "effect";

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
	return [...text.matchAll(/<file name="([^"]+)">([\s\S]*?)<\/file>/g)]
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
	for (const message of messages)
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
			if (typeof block.id === "string" && typeof path === "string")
				paths.set(block.id, path);
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
	for (const message of messages)
		for (const block of contentOf(message) ?? [])
			if (isContentBlock(block) && block.type === "image") imageCount++;
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
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer),
	);
	let enabled = false;
	let tempImagesDir: string | undefined;
	const [getTempImagesDir, resetTempImagesDir] = runtime.runSync(
		Effect.cachedInvalidateWithTTL(
			FileSystem.FileSystem.use((fs) =>
				fs.makeTempDirectory({ prefix: "pi-shake-images-" }).pipe(
					Effect.tap((directory) =>
						Effect.sync(() => {
							tempImagesDir = directory;
						}),
					),
				),
			),
			Duration.infinity,
		),
	);
	const materializeImage: MaterializeImage = (image) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const crypto = yield* Crypto.Crypto;
				const directory = yield* getTempImagesDir.pipe(
					Effect.tapError(() => resetTempImagesDir),
				);
				const extension =
					(
						{
							"image/avif": "avif",
							"image/bmp": "bmp",
							"image/gif": "gif",
							"image/jpeg": "jpg",
							"image/png": "png",
							"image/webp": "webp",
						} as Record<string, string>
					)[image.mimeType] ?? "img";
				const bytes = Result.getOrThrow(Encoding.decodeBase64(image.data));
				const digest = yield* crypto.digest("SHA-256", bytes);
				const file = path.join(
					directory,
					`${Encoding.encodeHex(digest)}.${extension}`,
				);
				yield* fs
					.writeFile(file, bytes, { flag: "wx" })
					.pipe(
						Effect.catch((error) =>
							error.reason._tag === "AlreadyExists"
								? Effect.void
								: Effect.fail(error),
						),
					);
				return file;
			}),
		);
	pi.registerCommand("shake-images", {
		description: "Keep only the latest two images in model context",
		handler: async (_args, ctx) => {
			enabled = true;
			ctx.ui.notify("Image context pruned to the latest two images", "info");
		},
	});
	pi.on("context", async (event) =>
		enabled
			? { messages: await pruneImages(event.messages, materializeImage) }
			: undefined,
	);
	pi.on("session_shutdown", async () => {
		if (tempImagesDir) {
			const directory = tempImagesDir;
			tempImagesDir = undefined;
			await runtime.runPromise(
				FileSystem.FileSystem.use((fs) =>
					fs.remove(directory, { force: true, recursive: true }),
				),
			);
		}
		await runtime.dispose();
	});
}
