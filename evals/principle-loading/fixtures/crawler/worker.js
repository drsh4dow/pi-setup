import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [shard, shards] = process.argv.slice(2).map(Number);
const urls = readFileSync("urls.txt", "utf8").trim().split("\n").filter((_, i) => i % shards === shard);

function recordResult(result) {
  const results = existsSync("results.json") ? JSON.parse(readFileSync("results.json", "utf8")) : [];
  results.push(result);
  writeFileSync("results.json", JSON.stringify(results, null, 2));
}

for (const url of urls) {
  try {
    const response = await fetch(url);
    const html = await response.text();
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? null;
    recordResult({ url, status: response.status, title, at: new Date().toISOString() });
  } catch (error) {
    recordResult({ url, status: null, error: String(error), at: new Date().toISOString() });
  }
}
