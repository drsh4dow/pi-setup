import assert from "node:assert/strict";
// Pure path operations do not need an Effect service.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { describe } from "node:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem, Schema } from "effect";
import {
  capture,
  e2eUnavailable,
  isDead,
  type PiSession,
  prompt,
  readStderr,
  sendKeys,
  setupPiSession,
  testEffect,
  waitFor,
} from "../../test/tmux.ts";
import {
  describeRequestFields,
  type FastModeConfig,
  FastModeSettings,
  fastRequestFields,
} from "../index.ts";

const skip = e2eUnavailable();

function footerModel(pane: string) {
  const matches = [...pane.matchAll(/\(([a-z0-9-]+)\)\s+(\S+)\s+•/g)];
  const last = matches.at(-1);
  assert.ok(last, `could not read the footer model from pane:\n${pane}`);

  return { provider: last[1], id: last[2] };
}

const savedConfig = Effect.fn("savedConfig")(function* (session: PiSession) {
  const fs = yield* FileSystem.FileSystem;

  const settings = yield* Schema.decodeEffect(Schema.fromJsonString(FastModeSettings))(
    yield* fs.readFileString(join(session.agentDir, "settings.json")),
  );

  return settings.fastMode;
}, Effect.provide(BunFileSystem.layer));

const persistedEnabled = Effect.fn("persistedEnabled")(function* (session: PiSession) {
  const config = yield* savedConfig(session);

  return config?.enabled === true;
});

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function noticeFor(
  enabled: boolean,
  config: FastModeConfig | undefined,
  model: { provider: string; id: string },
) {
  if (!enabled) return /Fast mode disabled\./;
  // The tmux session starts without --name, so it is never a subagent session.
  const fields = fastRequestFields(config, model, undefined);

  return fields
    ? new RegExp(escapeRegExp(`Fast mode enabled (${describeRequestFields(fields)}).`))
    : /Fast mode enabled, but .+ is not listed in the fastMode setting\./;
}

describe("fast-mode (real pi in tmux)", { skip }, () => {
  let session: PiSession;
  let model: { provider: string; id: string };
  let config: FastModeConfig | undefined;
  let initialEnabled: boolean;
  let expected: boolean;

  setupPiSession(
    (value) => {
      session = value;
    },
    (value) =>
      Effect.gen(function* () {
        initialEnabled = yield* persistedEnabled(value);
        expected = initialEnabled;
        model = footerModel(yield* capture(value));
        config = yield* savedConfig(value);
      }),
  );

  const toggle = Effect.fn("toggle")(function* <E>(
    trigger: Effect.Effect<void, E>,
    description: string,
  ) {
    const next = !expected;
    yield* trigger;
    yield* waitFor(
      session,
      (pane) => noticeFor(next, config, model).test(pane.match(/^.*Fast mode .*$/gm)?.at(-1) ?? ""),
      { timeoutMs: 30_000, description },
    );
    expected = next;
    assert.equal(
      yield* persistedEnabled(session),
      next,
      "settings.json fastMode.enabled does not reflect the announced state",
    );
    // The footer renders on its own frame after the notice.
    const indicatorShown = next && fastRequestFields(config, model, undefined) !== undefined;
    yield* waitFor(session, (pane) => /\u26a1\ufe0e? Fast/.test(pane) === indicatorShown, {
      timeoutMs: 5_000,
      description: `footer indicator ${indicatorShown ? "shown" : "hidden"}`,
    });
    assert.equal(yield* isDead(session), false);
  });

  testEffect("registers the extension without crashing", function* () {
    assert.equal(yield* isDead(session), false);
    assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
    const pane = yield* capture(session);
    assert.match(
      pane,
      /\[Extensions\][\s\S]*fast-mode/,
      `fast-mode missing from the startup banner:\n${pane}`,
    );
  });

  testEffect("/fast flips the announced state and persists it", function* () {
    yield* toggle(prompt(session, "/fast"), "first /fast notice");
    assert.notEqual(
      yield* persistedEnabled(session),
      initialEnabled,
      "/fast did not change the persisted setting",
    );
  });

  testEffect("/fast again flips back to the original state", function* () {
    yield* toggle(prompt(session, "/fast"), "second /fast notice");
    assert.equal(yield* persistedEnabled(session), initialEnabled);
  });

  testEffect("the ctrl+alt+m shortcut toggles the same state", function* () {
    yield* toggle(sendKeys(session, "C-M-m"), "shortcut notice (off)");
    yield* toggle(sendKeys(session, "C-M-m"), "shortcut notice (back on)");
    assert.equal(yield* persistedEnabled(session), initialEnabled);
  });

  testEffect("survives the toggles cleanly", function* () {
    assert.equal(yield* isDead(session), false);
    assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
    const pane = yield* capture(session);
    assert.match(pane, /%\/\d/, `footer stopped rendering:\n${pane}`);
  });
});
