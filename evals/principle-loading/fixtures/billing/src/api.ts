import { createServer } from "node:http";
import { invoicesForUser } from "./invoices.ts";

export const server = createServer((req, res) => {
  const match = req.url?.match(/^\/users\/([^/]+)\/invoices$/);
  if (req.method === "GET" && match) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(invoicesForUser(match[1])));
    return;
  }
  res.writeHead(404).end();
});
