import type { AddressInfo } from "node:net";
import { after } from "node:test";
import { createBillingServer } from "../src/http/server.ts";
import { makeDeps, type TestDeps } from "./helpers.ts";

export type Client = (
  method: string,
  path: string,
  options?: { token?: string; body?: unknown },
) => Promise<{ status: number; body: any }>;

/** Starts the API on a free port over makeDeps(), and stops it after the file's tests. */
export async function startApp(): Promise<{ request: Client; deps: TestDeps }> {
  const deps = makeDeps();
  const server = createBillingServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const request: Client = async (method, path, { token, body } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, body: await response.json() };
  };
  return { request, deps };
}
