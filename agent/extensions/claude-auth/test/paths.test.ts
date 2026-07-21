import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { getPiAgentDir } from "../paths.ts";

const prev = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prev;
});

test("getPiAgentDir: defaults to ~/.pi/agent", () => {
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(getPiAgentDir(), join(homedir(), ".pi", "agent"));
});

test("getPiAgentDir: honors PI_CODING_AGENT_DIR override", () => {
  process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-dir";
  assert.equal(getPiAgentDir(), "/tmp/custom-pi-dir");
});
