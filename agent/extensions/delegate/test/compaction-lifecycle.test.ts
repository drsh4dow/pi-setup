import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import compactionExtension from "../../compaction/index.ts";
import { DelegateManager } from "../manager.ts";
import { context } from "./manager-fixture.ts";

function gate() {
 let resolve!: () => void;
 const promise = new Promise<void>((done) => { resolve = done; });
 return { promise, resolve };
}

test("delegate waits for real SDK compaction and its continuation before success", { timeout: 10000 }, async () => {
 const cwd = await mkdtemp(join(tmpdir(), "pi-settlement-"));
 const compacting = gate();
 const compacted = gate();
 const releaseCompaction = gate();
 const delivered: string[] = [];
 let calls = 0;
 const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(cwd, "models-store.json"), refreshOnCreate: false });
 runtime.registerProvider("settlement-fixture", {
  baseUrl: "http://unused.invalid", apiKey: "fixture", api: "openai-completions",
  models: [{ id: "model", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
  streamSimple: (model) => {
   calls++;
   const text = calls === 1 ? "Working on the report" : calls === 2 ? "## Handoff\n- Objective: write report\n- Continuation: continue" : "Report complete";
   const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(), usage: { input: calls < 3 ? 8600 : 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: calls < 3 ? 8620 : 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
   const stream = createAssistantMessageEventStream();
   stream.push({ type: "done", reason: "stop", message });
   return stream;
  },
 });
 const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 }, retry: { enabled: false } });
 const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [
  (pi) => { pi.on("session_before_compact", async (event) => { if (event.reason === "manual") { compacting.resolve(); await releaseCompaction.promise; } }); },
  (pi) => { pi.events.on("compaction:delivery-pause", (paused) => { if (paused === false) compacted.resolve(); }); compactionExtension(pi, () => true); },
 ] });
 await loader.reload();
 const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model: runtime.getModel("settlement-fixture", "model"), resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), noTools: "all" });
 await session.bindExtensions({ mode: "print" });
 let disposed = false;
 const manager = new DelegateManager({ createSession: async () => session, shutdownSession: async () => { disposed = true; }, onSettled: (snapshot) => delivered.push(snapshot.status) });
 try {
  const job = manager.spawn({ task: "Write the report", cwd, ctx: context });
  await compacting.promise;
  // Drain runnable work while the actual SDK compaction is held open.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(manager.list([job.id])[0]?.status, "running");
  assert.equal(disposed, false);
  assert.deepEqual(delivered, []);
  releaseCompaction.resolve();
  const [result] = await Effect.runPromise(manager.wait([job.id]));
  assert.equal(result?.status, "done");
  assert.equal(result?.output, "Report complete");
  assert.equal(calls, 3);
  assert.deepEqual(delivered, ["done"]);
 } finally {
  releaseCompaction.resolve();
  await compacted.promise;
  await Effect.runPromise(manager.shutdown());
  await session.waitForIdle();
  session.dispose();
  await rm(cwd, { recursive: true, force: true });
 }
});
