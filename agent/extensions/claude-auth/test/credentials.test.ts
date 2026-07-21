import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  getCachedCredentials,
  initAccounts,
  loadPersistedAccountSource,
  parseOAuthResponse,
  saveAccountSource,
  setActiveAccountSource,
} from "../credentials.ts";
import { type ClaudeCredentials, writeBackCredentials } from "../keychain.ts";

let dir = "";
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.PI_CODING_AGENT_DIR;
  dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

test("parseOAuthResponse: maps a valid token response", () => {
  const creds = parseOAuthResponse(
    JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 100,
    }),
    "old-refresh",
    1_000,
  );
  assert.ok(creds);
  assert.equal(creds.accessToken, "new-access");
  assert.equal(creds.refreshToken, "new-refresh");
  assert.equal(creds.expiresAt, 1_000 + 100 * 1000);
});

test("parseOAuthResponse: keeps current refresh token when not rotated", () => {
  const creds = parseOAuthResponse(
    JSON.stringify({ access_token: "a", expires_in: 10 }),
    "keep-me",
    0,
  );
  assert.ok(creds);
  assert.equal(creds.refreshToken, "keep-me");
});

test("parseOAuthResponse: defaults expires_in to 36000s", () => {
  const creds = parseOAuthResponse(
    JSON.stringify({ access_token: "a" }),
    "r",
    0,
  );
  assert.ok(creds);
  assert.equal(creds.expiresAt, 36_000 * 1000);
});

test("parseOAuthResponse: returns null without an access token", () => {
  assert.equal(parseOAuthResponse(JSON.stringify({ error: "x" }), "r"), null);
  assert.equal(parseOAuthResponse("not json", "r"), null);
});

test("account source persistence round-trips", () => {
  assert.equal(loadPersistedAccountSource(), null);
  saveAccountSource("Claude Code-credentials");
  assert.equal(loadPersistedAccountSource(), "Claude Code-credentials");
});

test("reuses credentials until their actual expiry", () => {
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const credentials: ClaudeCredentials = {
    accessToken: "access",
    refreshToken: "",
    expiresAt: Date.now() + 30_000,
  };
  mkdirSync(join(dir, ".claude"));
  writeFileSync(
    join(dir, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: credentials }),
  );
  process.env.HOME = dir;
  process.env.PATH = "";
  initAccounts([{ label: "Claude", source: "file", credentials }]);
  setActiveAccountSource("file");

  try {
    assert.equal(getCachedCredentials()?.accessToken, "access");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("does not overwrite a refresh token rotated by Claude Code", () => {
  const previousHome = process.env.HOME;
  const credentialsPath = join(dir, ".claude", ".credentials.json");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "claude-access",
        refreshToken: "claude-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
  process.env.HOME = dir;

  try {
    const written = writeBackCredentials(
      "file",
      {
        accessToken: "pi-access",
        refreshToken: "pi-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
      "old-refresh",
    );
    const stored = JSON.parse(readFileSync(credentialsPath, "utf-8"));

    assert.equal(written, false);
    assert.equal(stored.claudeAiOauth.refreshToken, "claude-refresh");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
