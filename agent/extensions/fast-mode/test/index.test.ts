import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";
import extension, {
  type FastModeConfig,
  FastModeSettings,
  fastRequestFields,
  loadShortcuts,
  readConfig,
  withFastRequest,
} from "../index.ts";

type PiSettings = ReturnType<ExtensionAPI["getSettings"]>;

const config: FastModeConfig = {
  providers: {
    anthropic: {
      request: { speed: "fast", betas: ["fast-mode-2026-02-01"] },
      models: ["claude-opus-5-5"],
    },
    openai: { request: { service_tier: "fast" }, models: ["gpt-6.1-sol"] },
    "openai-codex": { request: { service_tier: "priority" }, models: ["gpt-6-astra"] },
  },
};

describe("fast mode config", () => {
  test("the repository settings contain a valid config", () => {
    const { readFileSync } = process.getBuiltinModule("node:fs");

    const { fastMode: repositoryConfig } = Schema.decodeSync(
      Schema.fromJsonString(FastModeSettings),
    )(readFileSync(new URL("../../../settings.json", import.meta.url), "utf8"));

    assert.ok(repositoryConfig, "settings.json fastMode does not match the config schema");

    assert.deepEqual(
      fastRequestFields(repositoryConfig, { provider: "anthropic", id: "claude-opus-5-5" }),
      { speed: "fast", betas: ["fast-mode-2026-02-01"] },
    );
  });

  test("ignores missing or invalid configs", () => {
    for (const settings of [
      unsafeFixture<PiSettings>({}),
      Object.assign(unsafeFixture<PiSettings>({}), {
        fastMode: { providers: { openai: { models: ["gpt-6.1-sol"] } } },
      }),
      Object.assign(unsafeFixture<PiSettings>({}), {
        fastMode: { providers: { openai: { request: {}, models: "gpt-6.1-sol" } } },
      }),
    ]) {
      assert.equal(readConfig(settings), undefined);
    }

    const settings = Object.assign(unsafeFixture<PiSettings>({ theme: "x" }), {
      fastMode: config,
    });

    assert.equal(readConfig(settings), config);
  });
});

describe("fast mode request mapping", () => {
  for (const [provider, id, fields] of [
    ["anthropic", "claude-opus-5-5", { speed: "fast", betas: ["fast-mode-2026-02-01"] }],
    ["openai", "gpt-6.1-sol", { service_tier: "fast" }],
    ["openai-codex", "gpt-6-astra", { service_tier: "priority" }],
  ] as const) {
    test(`maps ${provider}/${id} without mutating the payload`, () => {
      const model = { provider, id };
      const payload = { model: id, input: "hello" };
      assert.deepEqual(fastRequestFields(config, model), fields);
      assert.deepEqual(withFastRequest(config, model, payload), { ...payload, ...fields });
      assert.deepEqual(payload, { model: id, input: "hello" });
    });
  }

  test("merges array fields with the request's existing values once", () => {
    const model = { provider: "anthropic", id: "claude-opus-5-5" };

    for (const betas of [["oauth-2025-04-20"], ["oauth-2025-04-20", "fast-mode-2026-02-01"]]) {
      assert.deepEqual(withFastRequest(config, model, { model: model.id, betas }), {
        model: model.id,
        speed: "fast",
        betas: ["oauth-2025-04-20", "fast-mode-2026-02-01"],
      });
    }
  });

  test("does not tag models or providers outside the config", () => {
    for (const model of [
      { provider: "anthropic", id: "claude-fable-5-1" },
      { provider: "openai", id: "gpt-6-astra" },
      { provider: "opencode-go", id: "glm-5.3-flash" },
      { provider: "constructor", id: "gpt-6.1-sol" },
    ]) {
      const payload = { model: model.id };
      assert.equal(fastRequestFields(config, model), undefined);
      assert.equal(withFastRequest(config, model, payload), payload);
    }
  });

  test("preserves requests for other models, non-object payloads, and missing inputs", () => {
    const model = { provider: "openai", id: "gpt-6.1-sol" };

    for (const payload of [
      { model: "gpt-5.5", input: "hello", service_tier: "auto" },
      {},
      [],
      null,
      undefined,
      "request",
      1,
    ]) {
      assert.equal(withFastRequest(config, model, payload), payload);
    }

    const payload = { model: model.id };
    assert.equal(withFastRequest(undefined, model, payload), payload);
    assert.equal(withFastRequest(config, undefined, payload), payload);
  });
});

test("loads shortcut settings, filtering invalid entries and preserving disable settings", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "pi-fast-shortcuts-",
      });

      const load = loadShortcuts(directory);

      assert.deepEqual(yield* load, ["ctrl+alt+m"]);

      for (const [setting, expected] of [
        [false, []],
        [null, []],
        [" ctrl+shift+f ", ["ctrl+shift+f"]],
        [[1, null, {}, "", "enter", "CTRL+M", " ctrl+alt+f "], ["ctrl+alt+f"]],
        [["return", " "], ["ctrl+alt+m"]],
        [42, ["ctrl+alt+m"]],
      ]) {
        yield* fs.writeFileString(
          path.join(directory, "keybindings.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            "pi-fast-mode": setting,
          }),
        );
        assert.deepEqual(yield* load, expected);
      }

      yield* fs.writeFileString(path.join(directory, "keybindings.json"), "invalid json");
      assert.deepEqual(yield* load, ["ctrl+alt+m"]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  ));

test("/fast persists, announces, and shows toggles for fast models and only maps enabled requests", async (t) => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = process.getBuiltinModule("node:fs");

  const { tmpdir } = process.getBuiltinModule("node:os");
  const { join } = process.getBuiltinModule("node:path");
  const root = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ theme: "x", fastMode: config }));

  const adapter = extensionTestAdapter();

  let toggle: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;

  await extension(
    unsafeFixture<ExtensionAPI>({
      ...adapter.api,
      // Pi re-reads settings.json for each session, so session_start sees saved toggles.
      getSettings: () =>
        Object.assign(
          unsafeFixture<PiSettings>({}),
          Schema.decodeSync(Schema.fromJsonString(FastModeSettings))(
            readFileSync(settingsPath, "utf8"),
          ),
        ),
      registerCommand(name, command) {
        assert.equal(name, "fast");
        toggle = command.handler;
      },
      registerShortcut() {},
    }),
    root,
  );
  assert.ok(toggle);

  const notices: Array<[string, string | undefined]> = [];
  const indicators: Array<string | undefined> = [];

  const model = unsafeFixture<NonNullable<ExtensionCommandContext["model"]>>({
    provider: "openai",
    id: "gpt-6.1-sol",
  });

  const ctx = unsafeFixture<ExtensionCommandContext>({
    mode: "tui",
    model,
    ui: unsafeFixture<ExtensionCommandContext["ui"]>({
      notify(message, level) {
        notices.push([message, level]);
      },
      setStatus(key, text) {
        assert.equal(key, "speed");
        indicators.push(text);
      },
      theme: unsafeFixture<ExtensionCommandContext["ui"]["theme"]>({
        fg: (color, text) => `${color}:${text}`,
      }),
    }),
  });

  await adapter.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  const payload = { model: model.id, input: "hello" };

  const request = () =>
    adapter.emit("before_provider_request", { type: "before_provider_request", payload }, ctx);

  assert.equal(await request(), undefined);
  await toggle("", ctx);
  assert.deepEqual(await request(), { ...payload, service_tier: "fast" });

  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    theme: "x",
    fastMode: { ...config, enabled: true },
  });
  await adapter.emit("session_start", { type: "session_start", reason: "new" }, ctx);
  assert.deepEqual(await request(), { ...payload, service_tier: "fast" });

  const otherModel = unsafeFixture<NonNullable<ExtensionCommandContext["model"]>>({
    provider: "opencode-go",
    id: "glm-5.3-flash",
  });

  const selectModel = (nextModel: NonNullable<ExtensionCommandContext["model"]>) => {
    const previousModel = ctx.model;
    ctx.model = nextModel;

    return adapter.emit(
      "model_select",
      { type: "model_select", model: nextModel, previousModel, source: "set" },
      ctx,
    );
  };

  await selectModel(otherModel);
  await selectModel(model);

  await toggle("", ctx);
  assert.equal(await request(), undefined);
  ctx.model = undefined;
  await toggle("", ctx);
  assert.equal(await request(), payload);
  rmSync(root, { recursive: true });
  await toggle("", ctx);
  assert.deepEqual(notices, [
    ["Fast mode enabled (service_tier: fast).", "info"],
    ["Fast mode disabled.", "info"],
    ["Fast mode enabled, but unknown model is not listed in the fastMode setting.", "warning"],
    ["Could not save Fast mode setting.", "error"],
  ]);
  const indicator = "dim:\u26a1\ufe0e Fast";
  assert.deepEqual(indicators, [
    undefined,
    indicator,
    indicator,
    undefined,
    indicator,
    undefined,
    undefined,
  ]);
});
