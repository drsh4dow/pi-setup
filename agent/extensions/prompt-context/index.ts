import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Keep custom prompts structured so later extensions can add sections and Pi can
// record prompt changes without replacing the cached conversation prefix.
export default function promptContextExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", ({ systemPromptOptions: options }) => {
		if (!options.customPrompt) return;

		const tools = options.selectedTools.flatMap((name) => {
			const snippet = options.toolSnippets[name];

			return snippet ? [`- ${name}: ${snippet}`] : [];
		});

		const guidelines = [
			...new Set(
				[
					...options.selectedTools.flatMap(
						(name) => options.toolGuidelines[name] ?? [],
					),
					...options.promptGuidelines,
				]
					.values()
					.map((guideline) => guideline.trim())
					.filter(Boolean),
			),
		].map((guideline) => `- ${guideline}`);

		const sections: string[] = [];

		if (tools.length > 0)
			sections.push(`## Active tools\n\n${tools.join("\n")}`);

		if (guidelines.length > 0)
			sections.push(`## Tool guidelines\n\n${guidelines.join("\n")}`);

		if (sections.length > 0)
			options.sections.active_tool_context = sections.join("\n\n");
		else delete options.sections.active_tool_context;
	});
}
