import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  argument,
  customEntries,
  customMessages,
  parseSession,
  promptSections,
  sessionHead,
} from "../session.ts";

function lines(...entries: readonly object[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function system(id: string, sections: Record<string, string | null>) {
  return { type: "message", id, message: { role: "system", content: "", sections } };
}

function user(id: string, text: string) {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } };
}

function assistant(id: string, content: readonly object[]) {
  return { type: "message", id, message: { role: "assistant", content, stopReason: "toolUse" } };
}

test("a codemode script that failed before running made no tool calls", () => {
  const jsonl = [
    `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"codemode","arguments":{"code":"x"}}]}}`,
    `{"type":"message","message":{"role":"toolResult","toolCallId":"c1","toolName":"codemode","isError":true,"content":[{"type":"text","text":"The // @options: line must be the first line"}],"details":{}}}`,
  ].join("\n");

  assert.deepEqual(parseSession(jsonl).operations, []);
});

test("the prompt sections are the system messages replayed in order, a null removing one", () => {
  const jsonl = lines(
    { type: "session", id: "s" },
    system("m1", { preamble: "P", skills: "S1", mcp_servers: "M" }),
    system("m2", { skills: "S2", mcp_servers: null }),
    user("u1", "hi"),
    assistant("a1", [{ type: "text", text: "hello" }]),
    system("m3", { skills: "changed later" }),
  );

  assert.deepEqual(promptSections(jsonl), { preamble: "P", skills: "S2" });
});

test("a legacy session declares its prompt in a system message after the first user message", () => {
  const jsonl = lines(
    user("u1", "hi"),
    system("m1", { preamble: "P" }),
    assistant("a1", [{ type: "text", text: "x" }]),
  );

  assert.deepEqual(promptSections(jsonl), { preamble: "P" });
});

test("custom entries keep their entry id, type, and data; custom messages their text and details", () => {
  const jsonl = lines(
    { type: "session", id: "s" },
    { type: "custom", id: "c1", customType: "sh4dow-mode", data: { version: 1 } },
    {
      type: "custom_message",
      id: "c2",
      customType: "background-terminal-results",
      content: "bt-1 [done]",
      details: { ids: ["bt-1"] },
    },
  );

  assert.deepEqual(customEntries(jsonl), [
    { id: "c1", customType: "sh4dow-mode", data: { version: 1 } },
  ]);
  assert.deepEqual(customMessages(jsonl), [
    {
      id: "c2",
      customType: "background-terminal-results",
      text: "bt-1 [done]",
      details: { ids: ["bt-1"] },
    },
  ]);
});

test("each operation names the entry that issued it, and a nested call keeps its full arguments", () => {
  const longCommand = `launch.ts --kind delegate --role implementer ${"x".repeat(400)} --name tail`;

  const jsonl = lines(
    assistant("e1", [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/a" } }]),
    { type: "message", id: "r1", message: { role: "toolResult", toolCallId: "t1", content: [] } },
    assistant("e2", [{ type: "toolCall", id: "t2", name: "codemode", arguments: { code: "..." } }]),
    {
      type: "message",
      id: "r2",
      message: {
        role: "toolResult",
        toolCallId: "t2",
        content: [],
        details: {
          calls: [
            { name: "bg_start", args: `{"command":"${longCommand.slice(0, 60)}...`, status: "ok" },
          ],
        },
        nestedCalls: {
          calls: [{ name: "bg_start", status: "ok", arguments: { command: longCommand } }],
        },
      },
    },
  );

  const operations = parseSession(jsonl).operations;

  assert.deepEqual(
    operations.map((operation) => operation.entryId),
    ["e1", "e2"],
  );
  assert.equal(argument(operations[1], "command"), longCommand);
});

/** Arguments JSON as codemode records it in `details.calls`: cut short. */
const cut = (json: string) => `${json.slice(0, 60)}...`;

test("a nested call whose full arguments codemode left out keeps its cut ones, and its siblings keep their full ones", () => {
  const units = `id\tstate\n${"done-unit\tdone\n".repeat(20)}lost-unit\trunning\n`;

  const jsonl = lines(
    assistant("e1", [{ type: "toolCall", id: "t1", name: "codemode", arguments: { code: "..." } }]),
    {
      type: "message",
      id: "r1",
      message: {
        role: "toolResult",
        toolCallId: "t1",
        content: [],
        details: {
          calls: [
            {
              name: "write",
              args: cut(`{"path":"/s/brief.md","content":"${"b".repeat(99)}"}`),
              status: "ok",
            },
            {
              name: "write",
              args: cut(JSON.stringify({ path: "/s/units.tsv", content: units })),
              status: "ok",
            },
            { name: "bash", args: cut(`{"command":"echo ${"c".repeat(99)}"}`), status: "error" },
          ],
        },
        nestedCalls: {
          complete: true,
          calls: [
            { id: "n1", name: "write", status: "ok", argumentsBytes: 300_000 },
            {
              id: "n2",
              name: "write",
              status: "ok",
              arguments: { path: "/s/units.tsv", content: units },
            },
            { id: "n3", name: "bash", status: "error", argumentsBytes: 300_000 },
          ],
        },
      },
    },
  );

  const operations = parseSession(jsonl).operations;

  assert.deepEqual(
    operations.map((operation) => [operation.tool, operation.succeeded]),
    [
      ["write", true],
      ["write", true],
      ["bash", false],
    ],
  );
  assert.equal(argument(operations[0], "path"), "/s/brief.md");
  assert.equal(argument(operations[1], "content"), units);
  assert.equal(argument(operations[2], "command"), `echo ${"c".repeat(43)}...`);
});

test("a session head ends at the first user message and reads nothing after it", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-head-"));

  try {
    const path = join(dir, "s.jsonl");
    const head = lines({ type: "session", id: "s" }, user("u1", "hi"));

    writeFileSync(path, `${head}\n`);
    // A 4 GiB sparse tail: reading the whole file would fail, so a head read must stop early.
    truncateSync(path, 4 * 1024 ** 3);

    assert.equal(sessionHead(path), head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The bytes a process has read, from the kernel's count, so the test sees every read the head
// reader makes without reaching into it.
const BYTES_READ = `
import { readFileSync } from "node:fs";
const rchar = () => Number(/^rchar: (\\d+)$/m.exec(readFileSync("/proc/self/io", "utf8"))[1]);
const { sessionHead } = await import(process.argv[1]);
sessionHead(process.argv[2]);
const idle = [rchar(), rchar()];
const before = rchar();
sessionHead(process.argv[2]);
const after = rchar();
process.stdout.write(String(after - before - (idle[1] - idle[0])) + "\\n");
`;

test(
  "a session head reads at most one 4 KiB chunk past the end of its first user message",
  { skip: !existsSync("/proc/self/io") && "counting bytes read needs /proc/self/io" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "session-head-"));

    try {
      for (const [name, userText] of [
        ["short", "hi"],
        ["spanning chunks", "x".repeat(10_000)],
      ] as const) {
        const path = join(dir, "s.jsonl");
        const head = lines({ type: "session", id: "s" }, user("u1", userText));
        const body = `${JSON.stringify(assistant("a1", []))}\n`.repeat(40_000);

        writeFileSync(path, `${head}\n${body}`);

        const run = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            BYTES_READ,
            new URL("../session.ts", import.meta.url).href,
            path,
          ],
          { encoding: "utf8", timeout: 30_000 },
        );

        assert.equal(run.status, 0, run.stderr);

        const read = Number(run.stdout.trim());
        assert.match(
          run.stdout,
          /^-?\d+\n$/,
          JSON.stringify({ stdout: run.stdout, stderr: run.stderr }),
        );
        const headEnd = Buffer.byteLength(`${head}\n`);

        assert.ok(read >= headEnd, `${name}: read ${read} bytes, less than the head's ${headEnd}`);
        assert.ok(
          read <= headEnd + 4096,
          `${name}: read ${read} bytes, more than one 4 KiB chunk past the head's ${headEnd}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
