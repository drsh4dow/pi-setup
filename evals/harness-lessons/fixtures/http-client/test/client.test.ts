import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "../src/client.ts";

function failingThenOk(failures: number) {
  let calls = 0;

  const fetchImpl = async () => {
    calls += 1;

    return calls <= failures
      ? new Response("busy", { status: 503 })
      : Response.json({ ok: true });
  };

  return { fetchImpl: fetchImpl as typeof fetch, calls: () => calls };
}

test("a 5xx is retried up to retryCount times", async () => {
  const server = failingThenOk(2);
  const client = createClient({ baseUrl: "https://x.test", retryCount: 2 }, server.fetchImpl);

  assert.deepEqual(await client.getJson("/a"), { ok: true });
  assert.equal(server.calls(), 3);
});

test("the request fails once the retries run out", async () => {
  const server = failingThenOk(10);
  const client = createClient({ baseUrl: "https://x.test", retryCount: 1 }, server.fetchImpl);

  await assert.rejects(client.getJson("/a"), /failed with 503/);
  assert.equal(server.calls(), 2);
});

test("without the option, a request is retried three times", async () => {
  const server = failingThenOk(10);
  const client = createClient({ baseUrl: "https://x.test" }, server.fetchImpl);

  await assert.rejects(client.getJson("/a"));
  assert.equal(server.calls(), 4);
});
