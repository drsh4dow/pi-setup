import assert from "node:assert/strict";
import { suite, test } from "node:test";
import { Effect, Schema } from "effect";
import {
  childEnv,
  type Lineage,
  modeFrom,
  PaneId,
  placementFor,
  runtimeRoot,
  stderrRecorder,
  treeLabel,
  WorkspaceId,
} from "../launch.ts";

const parentPane = Schema.decodeSync(PaneId)("w1:p3");

const workspace = Schema.decodeSync(WorkspaceId)("w1");

const lineageAt = (depth: number): Lineage => ({ parentPane, workspace, depth });

const herdrEnv = {
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: "/run/herdr.sock",
  HERDR_PANE_ID: "w1:p3",
};

suite("placementFor", () => {
  test("a depth-1 child gets its own tab in the parent's workspace", () => {
    assert.deepEqual(placementFor(lineageAt(1)), { kind: "tab", workspace });
  });

  test("deeper children split their owner's pane", () => {
    assert.deepEqual(placementFor(lineageAt(2)), { kind: "split", target: parentPane });
    assert.deepEqual(placementFor(lineageAt(3)), { kind: "split", target: parentPane });
  });
});

suite("modeFrom", () => {
  test("runs in herdr one level below the caller when every herdr variable is set", () => {
    assert.deepEqual(Effect.runSync(modeFrom(herdrEnv)), {
      kind: "herdr",
      pane: parentPane,
      depth: 1,
    });
    assert.deepEqual(Effect.runSync(modeFrom({ ...herdrEnv, PI_SUBAGENT_DEPTH: "1" })), {
      kind: "herdr",
      pane: parentPane,
      depth: 2,
    });
  });

  for (const missing of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"] as const) {
    test(`falls back to print mode without ${missing}`, () => {
      const env = { ...herdrEnv, [missing]: undefined };

      assert.deepEqual(Effect.runSync(modeFrom(env)), { kind: "print" });
    });
  }
});

suite("runtimeRoot", () => {
  test("an empty XDG_RUNTIME_DIR counts as unset", () => {
    assert.equal(runtimeRoot({ XDG_RUNTIME_DIR: "" }, "/tmp"), "/tmp");
    assert.equal(runtimeRoot({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/tmp"), "/run/user/1000");
  });
});

suite("stderrRecorder", () => {
  test("keeps whole characters across chunk boundaries and at the limit", () => {
    const record = stderrRecorder(5);
    const encoder = new TextEncoder();
    const e = encoder.encode("é");

    const recorded = [
      record(Uint8Array.of(...encoder.encode("ab"), e[0] ?? 0)),
      record(Uint8Array.of(e[1] ?? 0, ...encoder.encode("cdé"))),
      record(encoder.encode("dropped")),
    ];

    assert.match(
      recorded.map((bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).join(""),
      /^abéc\npi-subagent: pi wrote more than [\d.]+ KiB to stderr; the rest is not forwarded\.\n$/,
    );
  });
});

suite("treeLabel", () => {
  test("starts with a visible character at every depth", () => {
    assert.equal(treeLabel(1, "alpha"), "└─ alpha");
    assert.equal(treeLabel(3, "alpha"), "│  │  └─ alpha");
  });
});

suite("childEnv", () => {
  test("keeps the launcher's environment but the pane's own herdr and terminal identity", () => {
    const env = childEnv(
      {
        ANTHROPIC_API_KEY: "secret",
        PATH: "/launcher/bin",
        HERDR_PANE_ID: "w1:p1",
        TERM: "dumb",
        PI_BACKGROUND_TERMINAL_NOTIFY_FD: "3",
      },
      { PATH: "/server/bin", HERDR_PANE_ID: "w1:p7", TERM: "xterm-256color" },
    );

    assert.deepEqual(env, {
      ANTHROPIC_API_KEY: "secret",
      PATH: "/launcher/bin",
      HERDR_PANE_ID: "w1:p7",
      TERM: "xterm-256color",
    });
  });
});
