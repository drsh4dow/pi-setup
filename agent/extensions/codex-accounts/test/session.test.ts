import assert from "node:assert/strict";
import test from "node:test";

const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
	process.getBuiltinModule("fs");
const { tmpdir } = process.getBuiltinModule("os");
const { join } = process.getBuiltinModule("path");

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Clock, ConfigProvider, Effect, Schema } from "effect";
import { createChild } from "../../delegate/runtime.ts";

const extensionPath = new URL("../index.ts", import.meta.url).pathname;
const modelId = "gpt-5.4";
const now = Effect.runSync(Clock.currentTimeMillis);
const environment = process.getBuiltinModule("process").env;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Pin = Schema.Struct({
	sessionId: Schema.String,
	provider: Schema.String,
	accountId: Schema.String,
});
const isPin = Schema.is(Pin);

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Fixture = Readonly<{ dir: string; cwd: string; sessions: string }>;

function json(value: unknown): string {
	return encodeJson(value);
}

function jwt(accountId: string): string {
	return `fixture.${Buffer.from(
		json({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url")}.fixture`;
}

function makeFixture(
	accounts: readonly string[] = ["alpha", "beta"],
	usage: Readonly<Record<string, number>> = { alpha: 70, beta: 10 },
): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "codex-session-test-"));
	const cwd = join(dir, "project");
	const sessions = join(dir, "sessions");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(dir, "codex-accounts.json"), json({ accounts }));
	writeFileSync(
		join(dir, "auth.json"),
		json({
			openai: { type: "api_key", key: "fixture" },
			...Object.fromEntries(
				[
					"openai-codex",
					...accounts.map((label) => `openai-codex@${label}`),
				].map((provider) => [
					provider,
					{
						type: "oauth",
						access: jwt(`${provider}-identity`),
						refresh: "fixture-refresh",
						expires: now + 60 * 60 * 1000,
					},
				]),
			),
		}),
	);
	writeFileSync(
		join(dir, "codex-usage.json"),
		json(
			Object.fromEntries(
				Object.entries(usage).map(([label, usedPercent]) => [
					label,
					{
						kind: "known",
						fetchedAt: now,
						accountId: `openai-codex@${label}-identity`,
						weekly: { usedPercent, resetAt: Math.floor(now / 1000) + 86_400 },
					},
				]),
			),
		),
	);
	return { dir, cwd, sessions };
}

const createSession = Effect.fn("test.createSession")(function* (
	fixture: Fixture,
	options: Readonly<{
		manager?: SessionManager;
		provider?: string;
		reason?: "new" | "resume" | "fork";
		expectedStartError?: RegExp;
	}> = {},
) {
	environment.PI_CODING_AGENT_DIR = fixture.dir;
	const settings = SettingsManager.create(fixture.cwd, fixture.dir);
	settings.setTransport("sse");
	const loader = new DefaultResourceLoader({
		cwd: fixture.cwd,
		agentDir: fixture.dir,
		settingsManager: settings,
		additionalExtensionPaths: [extensionPath],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	yield* Effect.tryPromise(() => loader.reload());
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.equal(loader.getExtensions().extensions.length, 1);
	const runtime = yield* Effect.tryPromise(() =>
		ModelRuntime.create({
			authPath: join(fixture.dir, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		}),
	);
	const model = runtime.getModel(options.provider ?? "openai-codex", modelId);
	assert.ok(model);
	const created = yield* Effect.tryPromise(() =>
		createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.dir,
			modelRuntime: runtime,
			model,
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager:
				options.manager ?? SessionManager.create(fixture.cwd, fixture.sessions),
			sessionStartEvent: {
				type: "session_start",
				reason: options.reason ?? "new",
			},
			noTools: "all",
		}),
	);
	const extensionErrors: string[] = [];
	yield* Effect.tryPromise(() =>
		created.session.bindExtensions({
			mode: "print",
			onError: (error) => extensionErrors.push(error.error),
		}),
	);
	if (options.expectedStartError) {
		assert.equal(extensionErrors.length, 1);
		assert.match(extensionErrors[0] ?? "", options.expectedStartError);
	} else {
		assert.deepEqual(extensionErrors, []);
	}
	return created.session;
});

function pins(session: Session): readonly (typeof Pin.Type)[] {
	return session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" &&
			entry.customType === "codex-account-pin" &&
			isPin(entry.data)
				? [entry.data]
				: [],
		);
}

const prompt = Effect.fn("test.prompt")(function* (
	session: Session,
	text = "Reply done.",
) {
	yield* Effect.tryPromise(() => session.prompt(text));
	yield* Effect.tryPromise(() => session.waitForIdle());
});

function sse(): Response {
	const events = [
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_fixture",
				role: "assistant",
				content: [{ type: "output_text", text: "Done." }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_fixture",
				status: "completed",
				output: [],
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		},
	];
	return new Response(
		events.map((event) => `data: ${json(event)}\n\n`).join(""),
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

test("real session chooses the highest weekly allowance and keeps its pin", () =>
	Effect.runPromise(
		Effect.acquireUseRelease(
			Effect.gen(function* () {
				const fixture = makeFixture();
				const requests: string[] = [];
				const originalFetch = globalThis.fetch;
				globalThis.fetch = (_input, init) => {
					requests.push(
						new Headers(init?.headers).get("chatgpt-account-id") ?? "missing",
					);
					return Promise.resolve(sse());
				};
				const session = yield* createSession(fixture);
				return { fixture, originalFetch, requests, session };
			}),
			({ requests, session }) =>
				Effect.gen(function* () {
					assert.equal(session.model?.provider, "openai-codex@beta");
					assert.deepEqual(pins(session), [
						{
							sessionId: session.sessionManager.getSessionId(),
							provider: "openai-codex@beta",
							accountId: "openai-codex@beta-identity",
						},
					]);
					yield* prompt(session, "first");
					yield* Effect.tryPromise(() =>
						session.setModel(
							session.modelRuntime.getModel("openai-codex@alpha", modelId) ??
								assert.fail("missing alpha model"),
						),
					);
					assert.equal(session.model?.provider, "openai-codex@beta");
					yield* prompt(session, "second");
					assert.deepEqual(requests, [
						"openai-codex@beta-identity",
						"openai-codex@beta-identity",
					]);
					assert.equal(pins(session).length, 1);
				}),
			({ fixture, originalFetch, session }) =>
				Effect.sync(() => {
					session.dispose();
					globalThis.fetch = originalFetch;
					rmSync(fixture.dir, { recursive: true, force: true });
				}),
		),
	));

test("reload and resume retain the pin; fork selects independently", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fixture = makeFixture();
			environment.PI_CODING_AGENT_DIR = fixture.dir;
			let session: Session | undefined;
			let resumed: Session | undefined;
			let forked: Session | undefined;
			let child: Session | undefined;
			let delayed: Session | undefined;
			const originalFetch = globalThis.fetch;
			try {
				globalThis.fetch = () => Promise.resolve(sse());
				session = yield* createSession(fixture);
				const active = session;
				// Pi does not persist empty sessions. Exercise a real turn before reopening.
				yield* prompt(active);
				assert.equal(active.model?.provider, "openai-codex@beta");
				yield* Effect.tryPromise(() => active.reload());
				assert.equal(session.model?.provider, "openai-codex@beta");
				const file = session.sessionFile;
				assert.ok(file);
				session.dispose();
				session = undefined;
				writeFileSync(
					join(fixture.dir, "codex-usage.json"),
					json({
						alpha: {
							kind: "known",
							fetchedAt: now,
							accountId: "openai-codex@alpha-identity",
							weekly: {
								usedPercent: 1,
								resetAt: Math.floor(now / 1000) + 86_400,
							},
						},
						beta: {
							kind: "known",
							fetchedAt: now,
							accountId: "openai-codex@beta-identity",
							weekly: {
								usedPercent: 99,
								resetAt: Math.floor(now / 1000) + 86_400,
							},
						},
					}),
				);
				resumed = yield* createSession(fixture, {
					manager: SessionManager.open(file, fixture.sessions),
					reason: "resume",
				});
				assert.equal(resumed.model?.provider, "openai-codex@beta");
				child = yield* createChild(
					fixture.cwd,
					resumed.model,
					"low",
					fixture.dir,
					resumed.sessionManager,
				).pipe(
					Effect.provideService(
						ConfigProvider.ConfigProvider,
						ConfigProvider.fromUnknown({
							PI_CHILD_EXTENSION_PATHS: extensionPath,
						}),
					),
				);
				assert.equal(child.model?.provider, "openai-codex@alpha");
				const forkManager = SessionManager.forkFrom(
					file,
					fixture.cwd,
					fixture.sessions,
				);
				forked = yield* createSession(fixture, {
					manager: forkManager,
					reason: "fork",
				});
				assert.equal(forked.model?.provider, "openai-codex@alpha");
				assert.equal(pins(forked).length, 2);
				assert.equal(
					pins(forked).at(-1)?.sessionId,
					forked.sessionManager.getSessionId(),
				);
				const resumedSession = resumed;
				yield* Effect.tryPromise(() =>
					resumedSession.setModel(
						resumedSession.modelRuntime.getModel("openai", modelId) ??
							assert.fail("missing OpenAI model"),
					),
				);
				delayed = yield* createSession(fixture, {
					manager: SessionManager.forkFrom(file, fixture.cwd, fixture.sessions),
					reason: "fork",
					provider: "openai",
				});
				const delayedSession = delayed;
				yield* Effect.tryPromise(() => delayedSession.reload());
				assert.equal(delayedSession.model?.provider, "openai");
				yield* Effect.tryPromise(() =>
					delayedSession.setModel(
						delayedSession.modelRuntime.getModel("openai-codex", modelId) ??
							assert.fail("missing Codex model"),
					),
				);
				assert.equal(delayedSession.model?.provider, "openai-codex@alpha");
			} finally {
				session?.dispose();
				resumed?.dispose();
				forked?.dispose();
				child?.dispose();
				delayed?.dispose();
				globalThis.fetch = originalFetch;
				rmSync(fixture.dir, { recursive: true, force: true });
			}
		}),
	));

test("existing Codex history keeps the original login", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fixture = makeFixture();
			const originalFetch = globalThis.fetch;
			let session: Session | undefined;
			const requests: string[] = [];
			try {
				globalThis.fetch = (_input, init) => {
					requests.push(
						new Headers(init?.headers).get("chatgpt-account-id") ?? "missing",
					);
					return Promise.resolve(sse());
				};
				const manager = SessionManager.create(fixture.cwd, fixture.sessions);
				manager.appendMessage({
					role: "assistant",
					provider: "openai-codex",
					api: "openai-codex-responses",
					model: modelId,
					content: [{ type: "text", text: "Earlier answer" }],
					timestamp: now,
					stopReason: "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				});
				session = yield* createSession(fixture, { manager, reason: "resume" });
				assert.equal(session.model?.provider, "openai-codex");
				assert.equal(pins(session).at(-1)?.accountId, "openai-codex-identity");
				yield* prompt(session);
				assert.deepEqual(requests, ["openai-codex-identity"]);
			} finally {
				session?.dispose();
				globalThis.fetch = originalFetch;
				rmSync(fixture.dir, { recursive: true, force: true });
			}
		}),
	));

test("usage command reuses fresh cache without changing the pin", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fixture = makeFixture();
			const sessions: Session[] = [];
			const originalFetch = globalThis.fetch;
			let calls = 0;
			try {
				globalThis.fetch = () => {
					calls++;
					return Promise.resolve(sse());
				};
				const session = yield* createSession(fixture);
				sessions.push(session);
				yield* prompt(session, "/codex-usage");
				yield* prompt(session, "/codex-usage");
				assert.equal(calls, 0);
				assert.equal(pins(session).length, 1);
				assert.equal(session.model?.provider, "openai-codex@beta");
			} finally {
				for (const session of sessions) session.dispose();
				globalThis.fetch = originalFetch;
				rmSync(fixture.dir, { recursive: true, force: true });
			}
		}),
	));

test("missing configuration creates an empty scaffold and retains default Codex", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fixture = makeFixture([]);
			const configPath = join(fixture.dir, "codex-accounts.json");
			rmSync(configPath);
			const originalFetch = globalThis.fetch;
			const sessions: Session[] = [];
			const requests: string[] = [];
			try {
				globalThis.fetch = (_input, init) => {
					requests.push(
						new Headers(init?.headers).get("chatgpt-account-id") ?? "missing",
					);
					return Promise.resolve(sse());
				};
				const session = yield* createSession(fixture);
				sessions.push(session);
				assert.equal(
					readFileSync(configPath, "utf8"),
					'{\n  "accounts": []\n}\n',
				);
				assert.equal(session.model?.provider, "openai-codex");
				yield* prompt(session);
				assert.deepEqual(requests, ["openai-codex-identity"]);
				writeFileSync(configPath, '{ "accounts": [] }\n');
				yield* Effect.tryPromise(() => session.reload());
				assert.equal(readFileSync(configPath, "utf8"), '{ "accounts": [] }\n');
				assert.equal(session.model?.provider, "openai-codex");
			} finally {
				for (const session of sessions) session.dispose();
				globalThis.fetch = originalFetch;
				rmSync(fixture.dir, { recursive: true, force: true });
			}
		}),
	));

test("no eligible account fails closed before transport", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fixture = makeFixture(["alpha"], { alpha: 100 });
			let calls = 0;
			const originalFetch = globalThis.fetch;
			try {
				globalThis.fetch = () => {
					calls++;
					return Promise.resolve(sse());
				};
				const session = yield* createSession(fixture, {
					expectedStartError: /No Codex account has fresh weekly allowance/,
				});
				yield* prompt(session);
				assert.equal(calls, 0);
				assert.equal(session.model?.provider, "openai-codex");
				session.dispose();
			} finally {
				globalThis.fetch = originalFetch;
				rmSync(fixture.dir, { recursive: true, force: true });
			}
		}),
	));

test("reauthenticated pinned provider cannot silently change identity", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fixture = makeFixture();
			let session: Session | undefined;
			const requests: string[] = [];
			const originalFetch = globalThis.fetch;
			try {
				globalThis.fetch = (input) => {
					requests.push(String(input));
					return Promise.resolve(sse());
				};
				session = yield* createSession(fixture);
				const active = session;
				const credential = (
					provider: string,
					accountId = `${provider}-identity`,
				) => ({
					type: "oauth",
					access: jwt(accountId),
					refresh: "fixture-refresh",
					expires: now + 60 * 60 * 1000,
				});
				writeFileSync(
					join(fixture.dir, "auth.json"),
					json({
						"openai-codex": credential("openai-codex"),
						"openai-codex@alpha": credential("openai-codex@alpha"),
						"openai-codex@beta": credential(
							"openai-codex@beta",
							"replacement-identity",
						),
					}),
				);
				yield* Effect.tryPromise(() => active.modelRuntime.refresh());
				yield* prompt(active);
				const response = active.state.messages.at(-1);
				assert.equal(response?.role, "assistant");
				assert.match(
					response?.role === "assistant" ? (response.errorMessage ?? "") : "",
					/changed identity/,
				);
				assert.equal(
					requests.filter((url) => url.includes("/responses")).length,
					0,
				);
				assert.equal(session.model?.provider, "openai-codex@beta");
			} finally {
				session?.dispose();
				globalThis.fetch = originalFetch;
				rmSync(fixture.dir, { recursive: true, force: true });
			}
		}),
	));
