import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Assert } from "typebox/value";
import editFeedback from "../index.ts";

// Loaded by the real CLI. Capture the definition at the registration boundary,
// then invoke it from a command without a model or credentials.
export default function probe(pi: ExtensionAPI) {
	editFeedback({
		...pi,
		registerTool(tool) {
			pi.registerTool(tool);
			pi.registerCommand("edit-feedback-probe", {
				description: "Exercise edit registration with a local fixture",
				handler(_args, ctx) {
					const input: unknown = {
						path: "fixture.txt",
						edits: [{ oldText: "repeat", newText: "new" }],
					};
					Assert(tool.parameters, input);
					return tool.execute("probe", input, undefined, undefined, ctx).then(
						() => {
							throw new Error("Expected rejection");
						},
						(error) => {
							process.stdout.write(
								`EDIT_FEEDBACK_PROBE:${error instanceof Error ? error.message : String(error)}\n`,
							);
						},
					);
				},
			});
		},
	});
}
