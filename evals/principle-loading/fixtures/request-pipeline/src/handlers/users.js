import { context } from "../context.js";

export function getUsers() {
  context.res.writeHead(200, { "content-type": "application/json" });
  context.res.end(JSON.stringify({ users: ["ada", "grace"], requestedBy: context.user }));
}
