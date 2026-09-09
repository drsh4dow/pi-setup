import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

function promptContext(options: BuildSystemPromptOptions): string | undefined {
	const tools = (options.selectedTools ?? []).flatMap((name) => {
		const snippet = options.toolSnippets?.[name];
		return snippet ? [`- ${name}: ${snippet}`] : [];
	});
	const guidelines = [
		...new Set(
			(options.promptGuidelines ?? [])
				.map((guideline) => guideline.trim())
				.filter(Boolean),
		),
	].map((guideline) => `- ${guideline}`);
	const sections: string[] = [];
	if (tools.length > 0) sections.push(`## Active tools\n\n${tools.join("\n")}`);
	if (guidelines.length > 0)
		sections.push(`## Tool guidelines\n\n${guidelines.join("\n")}`);
	return sections.length > 0 ? sections.join("\n\n") : undefined;
}

export default function promptContextExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		if (!event.systemPromptOptions.customPrompt) return;
		const context = promptContext(event.systemPromptOptions);
		if (!context) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
	});
}
