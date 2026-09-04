// Pi's extension loader only resolves the whitelisted pi-ai entrypoints
// (root, /compat, /oauth, /providers/all); deep provider imports break under
// the globally installed pi.
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Each label is a Codex Account Alias: the built-in openai-codex provider
// re-registered under its own id, so the account owns its own auth.json entry
// and its models appear in the selector, the model cycle, and delegate model
// settings. The primary account keeps the bare "openai-codex" id. See
// docs/adr/0004-codex-account-aliases.md.
const ACCOUNT_LABELS = ["cyber"];

export function codexAliasProvider(label: string) {
	const base = builtinProviders().find(
		(provider) => provider.id === "openai-codex",
	);
	if (!base) {
		throw new Error("No built-in openai-codex provider to alias.");
	}
	const id = `openai-codex-${label}`;
	const oauth = base.auth.oauth;
	if (!oauth) {
		throw new Error(
			"The built-in openai-codex provider has no OAuth flow to alias.",
		);
	}
	return {
		...base,
		id,
		name: `OpenAI Codex (${label})`,
		auth: { oauth: { ...oauth, name: `${oauth.name} — ${label}` } },
		getModels: () => {
			const models = [...base.getModels()];
			if (label === "cyber") {
				const template = models.find((model) => model.id === "gpt-5.6-sol");
				if (!template) {
					throw new Error("No gpt-5.6-sol model to template cyber models.");
				}
				models.push({
					...template,
					id: "gpt-daybreak-blue-latest",
					name: "Daybreak Blue",
				});
				if (!models.some((model) => model.id === "gpt-6-astra")) {
					// Astra metadata from the refreshed Codex catalog.
					models.push({
						...template,
						id: "gpt-6-astra",
						name: "GPT-6 Astra",
						cost: {
							input: 10,
							output: 50,
							cacheRead: 1,
							cacheWrite: 12.5,
							tiers: [
								{
									inputTokensAbove: 272000,
									input: 20,
									output: 75,
									cacheRead: 2,
									cacheWrite: 25,
								},
							],
						},
						thinkingLevelMap: {
							off: null,
							minimal: "low",
							low: "low",
							medium: "medium",
							high: "high",
							xhigh: "xhigh",
							max: "max",
						},
					});
				}
			}
			return models.map((model) => ({ ...model, provider: id }));
		},
	};
}

export default function codexAccounts(pi: ExtensionAPI) {
	for (const label of ACCOUNT_LABELS) {
		pi.registerProvider(codexAliasProvider(label));
	}
}
