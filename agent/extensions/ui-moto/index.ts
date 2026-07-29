import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, Path } from "effect";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BAR_FILL = "─";

const PALETTE: Rgb[] = [
	[22, 83, 189],
	[48, 129, 247],
	[93, 171, 255],
	[151, 205, 255],
	[93, 171, 255],
	[48, 129, 247],
];

type Rgb = [number, number, number];

function mix(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * t);
}

function colorAt(position: number): Rgb {
	const scaled = (((position % 1) + 1) % 1) * PALETTE.length;
	const index = Math.floor(scaled);
	const nextIndex = (index + 1) % PALETTE.length;
	const t = scaled - index;
	const a = PALETTE[index];
	const b = PALETTE[nextIndex];
	if (!a || !b) throw new Error("palette index out of bounds");

	return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function paint([r, g, b]: Rgb, text: string): string {
	return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function gradient(text: string, phase: number): string {
	const chars = [...text];
	const span = Math.max(chars.length - 1, 1);

	return chars
		.map((char, index) =>
			char === " " ? char : paint(colorAt(index / span + phase), char),
		)
		.join("");
}

const projectName = Effect.runSync(
	Path.Path.pipe(
		Effect.map((path) => path.basename(process.cwd()) || "session"),
		Effect.provide(BunPath.layer),
	),
);

function headerLine(width: number, modelId: string): string {
	if (width <= 0) return "";

	const label = ` PI / ${modelId} / ${projectName} `;
	const labelChars = [...label];
	if (labelChars.length >= width) return labelChars.slice(0, width).join("");

	const fillWidth = width - labelChars.length;
	const leftWidth = Math.floor(fillWidth / 2);
	const rightWidth = fillWidth - leftWidth;

	return `${BAR_FILL.repeat(leftWidth)}${label}${BAR_FILL.repeat(rightWidth)}`;
}

function renderHeader(width: number, modelId: string): string[] {
	return ["", `${BOLD}${gradient(headerLine(width, modelId), 0)}${RESET}`, ""];
}

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;
	let currentModelId = "no model selected";

	function installHeader(ctx: ExtensionContext): void {
		ctx.ui.setHeader((tui) => {
			requestRender = () => tui.requestRender();

			return {
				render: (width: number) => renderHeader(width, currentModelId),
				invalidate: () => tui.requestRender(),
			};
		});
	}

	pi.on("session_start", (_event, ctx) => {
		currentModelId = ctx.model?.id ?? "no model selected";
		if (ctx.hasUI) installHeader(ctx);
	});

	pi.on("model_select", (event) => {
		currentModelId = event.model.id;
		requestRender?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		requestRender = undefined;
		if (ctx.hasUI) ctx.ui.setHeader(undefined);
	});
}
