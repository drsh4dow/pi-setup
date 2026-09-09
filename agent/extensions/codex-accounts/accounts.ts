import type { Context, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Schema } from "effect";

export const LOGICAL_PROVIDER = "openai-codex";
export const ALIAS_PREFIX = `${LOGICAL_PROVIDER}@`;
export type CodexAccount = Readonly<{ label: string; provider: string }>;

const AccountConfig = Schema.Struct({
	accounts: Schema.Array(
		Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)),
	),
});
const TokenIdentity = Schema.fromJsonString(
	Schema.Struct({
		"https://api.openai.com/auth": Schema.Struct({
			chatgpt_account_id: Schema.NonEmptyString,
		}),
	}),
);

export function parseAccountLabels(value: unknown): CodexAccount[] {
	const { accounts } = Schema.decodeUnknownSync(AccountConfig)(value);
	if (new Set(accounts).size !== accounts.length)
		throw new Error("Codex account labels must be unique.");
	return [...accounts]
		.sort()
		.map((label) => ({ label, provider: `${ALIAS_PREFIX}${label}` }));
}

export function accountIdFromToken(token: string): string {
	const payload = token.split(".")[1];
	if (!payload) throw new Error("Codex OAuth token had no account identity.");
	return Schema.decodeSync(TokenIdentity)(
		Buffer.from(payload, "base64url").toString("utf8"),
	)["https://api.openai.com/auth"].chatgpt_account_id;
}

export function isCodexProvider(provider: string): boolean {
	return provider === LOGICAL_PROVIDER || provider.startsWith(ALIAS_PREFIX);
}

export function labelFromProvider(provider: string): string | undefined {
	return provider.startsWith(ALIAS_PREFIX)
		? provider.slice(ALIAS_PREFIX.length)
		: undefined;
}

function logicalContext(context: Context): Context {
	return {
		...context,
		messages: context.messages.map((message) =>
			message.role === "assistant" && isCodexProvider(message.provider)
				? { ...message, provider: LOGICAL_PROVIDER }
				: message,
		),
	};
}

// Pi keys credentials and refresh locks by provider ID. Only the wire protocol
// sees the logical provider, preserving Codex's tool-call and reasoning history.
export function accountProvider(
	account: CodexAccount,
	authorize: (apiKey: string | undefined) => void = () => {},
): Provider {
	const base = builtinProviders().find(
		(provider) => provider.id === LOGICAL_PROVIDER,
	);
	if (!base) throw new Error("The installed Pi runtime has no Codex provider.");
	return {
		...base,
		id: account.provider,
		name:
			account.provider === LOGICAL_PROVIDER
				? base.name
				: `OpenAI Codex (${account.label})`,
		getModels: () =>
			base
				.getModels()
				.map((model) => ({ ...model, provider: account.provider })),
		stream: (model, context, options) => {
			authorize(options?.apiKey);
			return base.stream(
				{ ...model, provider: LOGICAL_PROVIDER },
				logicalContext(context),
				options,
			);
		},
		streamSimple: (model, context, options) => {
			authorize(options?.apiKey);
			return base.streamSimple(
				{ ...model, provider: LOGICAL_PROVIDER },
				logicalContext(context),
				options,
			);
		},
	};
}
