import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSession } from "../session.ts";

test("a codemode script that failed before running made no tool calls", () => {
  const jsonl = [
    `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"codemode","arguments":{"code":"x"}}]}}`,
    `{"type":"message","message":{"role":"toolResult","toolCallId":"c1","toolName":"codemode","isError":true,"content":[{"type":"text","text":"The // @options: line must be the first line"}],"details":{}}}`,
  ].join("\n");

  assert.deepEqual(parseSession(jsonl).operations, []);
});
