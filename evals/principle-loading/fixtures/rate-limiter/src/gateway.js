import { createServer } from "node:http";
import { allow } from "./limiter.js";

export const server = createServer((req, res) => {
  if (!allow(req.socket.remoteAddress)) {
    res.writeHead(503).end("rate limited");
    return;
  }
  res.writeHead(200).end("ok");
});
