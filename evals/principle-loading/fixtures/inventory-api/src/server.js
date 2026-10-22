import { createServer } from "node:http";
import { listItems } from "./items.js";

export const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/items") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listItems(url.searchParams)));
    return;
  }
  res.writeHead(404).end();
});

if (import.meta.main) server.listen(3000);
