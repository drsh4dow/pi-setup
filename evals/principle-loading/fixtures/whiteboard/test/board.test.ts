import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardClient } from "../src/client.ts";
import type { Operation } from "../src/board.ts";

test("operations from one client reach the other", () => {
  const sent: Operation[] = [];
  const ada = new BoardClient("ada", (op) => sent.push(op));
  const grace = new BoardClient("grace", () => {});
  ada.perform({ type: "add", author: "ada", shape: { id: "s1", kind: "rect", at: { x: 0, y: 0 }, width: 10, height: 10, color: "red" } });
  for (const op of sent) grace.receive(op);
  assert.equal(grace.board.get("s1")?.kind, "rect");
});
