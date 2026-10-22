import { createServer } from "node:http";
import { createApp } from "./app.js";

const app = createApp();
export const server = createServer((req, res) => app.handle(req, res));

if (import.meta.main) server.listen(3000);
