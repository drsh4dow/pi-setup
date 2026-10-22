import { Router } from "./router.js";

export function createApp() {
  const router = new Router();
  return { handle: (req, res) => router.route(req, res) };
}
