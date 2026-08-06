import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Each label is a Codex Account Alias: the built-in openai-codex provider
// re-registered under its own id, so the account owns its own auth.json entry
// and its models appear in the selector, the model cycle, and delegate model
// settings. The primary account keeps the bare "openai-codex" id. See
// docs/adr/0004-codex-account-aliases.md.
const ACCOUNT_LABELS = ["cyber"];

export function codexAliasProvider(label: string) {
	const base = openaiCodexProvider();
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
		getModels: () =>
			base.getModels().map((model) => ({ ...model, provider: id })),
	};
}

export default function codexAccounts(pi: ExtensionAPI) {
	for (const label of ACCOUNT_LABELS) {
		pi.registerProvider(codexAliasProvider(label));
	}
}
