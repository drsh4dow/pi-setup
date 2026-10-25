import { readFile } from "node:fs/promises";
import { messages } from "./messages.mjs";

const versionFile = new URL("./version.json", import.meta.url);

async function version() {
  try {
    return JSON.parse(await readFile(versionFile, "utf8"));
  } catch {
    return { commit: "dev" };
  }
}

export async function handle(url) {
  if (url.pathname === "/health") return { status: 200, body: { ok: true } };

  if (url.pathname === "/version") return { status: 200, body: await version() };

  return { status: 404, body: { error: messages["unknown-path"] } };
}
