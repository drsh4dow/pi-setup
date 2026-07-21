import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import extension from "../index.ts";

const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let dir = "";

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

test("persists Claude credentials only when they change", async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-extension-"));
  const claudeDir = join(dir, ".claude");
  const agentDir = join(dir, ".pi", "agent");
  const expires = Date.now() + 3_600_000;
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: expires,
        subscriptionType: "max",
      },
    }),
  );
  process.env.HOME = dir;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  let sessionStart: ((event: unknown, context: unknown) => void) | undefined;
  const pi = {
    on(event: string, handler: (event: unknown, context: unknown) => void) {
      if (event === "session_start") sessionStart = handler;
    },
    registerProvider() {},
  };
  await extension(pi as never);

  assert.equal(existsSync(join(agentDir, "auth.json")), false);

  let stored = {
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires,
  };
  let writes = 0;
  const context = {
    modelRegistry: {
      authStorage: {
        get: () => stored,
        set: (_provider: string, credential: typeof stored) => {
          stored = credential;
          writes++;
        },
      },
    },
  };

  sessionStart?.({}, context);
  assert.equal(writes, 0);

  stored = { ...stored, access: "stale" };
  sessionStart?.({}, context);
  sessionStart?.({}, context);
  assert.equal(writes, 1);
  assert.equal(stored.access, "access");
});
