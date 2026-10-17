import assert from "node:assert/strict";
import { suite, test } from "node:test";
import { Effect, Schema } from "effect";
import {
  childEnv,
  type Lineage,
  modeFrom,
  PaneId,
  placementFor,
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
