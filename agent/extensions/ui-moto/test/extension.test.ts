import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";
import uiMoto from "../index.ts";

function plain(text: string): string {
	let result = "";
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) !== 27) {
			result += text[index];
			continue;
		}
		index = text.indexOf("m", index);
	}
	return result;
}

test("installs, updates, and removes the session header", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			let headerFactory: ((tui: TUI) => Component) | undefined;
			let renders = 0;
			const setHeaders: Array<"factory" | "cleared"> = [];
			const context = unsafeFixture<ExtensionContext>({
				hasUI: true,
				model: unsafeFixture<ExtensionContext["model"]>({ id: "model-one" }),
				ui: unsafeFixture<ExtensionContext["ui"]>({
					setHeader: (factory: typeof headerFactory) => {
						headerFactory = factory;
						setHeaders.push(factory ? "factory" : "cleared");
					},
				}),
			});
			const adapter = extensionTestAdapter();
			uiMoto(adapter.api);

			yield* Effect.promise(() =>
				adapter.emit(
					"session_start",
					{ type: "session_start", reason: "startup" },
					context,
				),
			);
			assert.equal(setHeaders.at(-1), "factory");
			assert.ok(headerFactory);
			const component = headerFactory(
				unsafeFixture<TUI>({ requestRender: () => renders++ }),
			);
			const project = process.cwd().split("/").at(-1);
			assert.ok(project);
			const label = ` PI / model-one / ${project} `;
			const fill = 60 - label.length;
			assert.deepEqual(component.render(60).map(plain), [
				"",
				`${"─".repeat(Math.floor(fill / 2))}${label}${"─".repeat(Math.ceil(fill / 2))}`,
				"",
			]);

			yield* Effect.promise(() =>
				adapter.emit(
					"model_select",
					unsafeFixture({
						type: "model_select",
						model: { id: "model-two" },
						previousModel: { id: "model-one" },
						source: "cycle",
					}),
					context,
				),
			);
			assert.equal(renders, 1);
			assert.match(
				plain(component.render(60)[1] ?? ""),
				/ PI \/ model-two \/ /,
			);

			yield* Effect.promise(() =>
				adapter.emit(
					"session_shutdown",
					{ type: "session_shutdown", reason: "quit" },
					context,
				),
			);
			assert.equal(setHeaders.at(-1), "cleared");
			yield* Effect.promise(() =>
				adapter.emit(
					"model_select",
					unsafeFixture({
						type: "model_select",
						model: { id: "model-three" },
						previousModel: { id: "model-two" },
						source: "set",
					}),
					context,
				),
			);
			assert.equal(renders, 1);
		}),
	));

test("header preserves graphemes within terminal column limits", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			let factory: Parameters<ExtensionContext["ui"]["setHeader"]>[0];
			const context = unsafeFixture<ExtensionContext>({
				mode: "tui",
				hasUI: true,
				model: { id: "项目👩‍💻é" },
				ui: {
					setHeader: (value: typeof factory) => {
						factory = value;
					},
				},
			});
			const adapter = extensionTestAdapter();
			uiMoto(adapter.api);
			yield* Effect.promise(() =>
				adapter.emit(
					"session_start",
					{ type: "session_start", reason: "startup" },
					context,
				),
			);
			assert.ok(factory);
			const header = factory(
				unsafeFixture<TUI>({ requestRender() {} }),
				unsafeFixture({}),
			);
			for (let width = 0; width <= 80; width++) {
				for (const line of header.render(width))
					assert.ok(
						visibleWidth(line) <= width,
						`width ${width}: ${plain(line)}`,
					);
			}
			assert.match(header.render(80)[1] ?? "", /👩‍💻/);
			assert.match(header.render(80)[1] ?? "", /é/);
		}),
	));
