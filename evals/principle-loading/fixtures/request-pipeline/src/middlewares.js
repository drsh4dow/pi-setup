import { context } from "./context.js";

export const middlewares = [
  (next) => {
    context.startedAt = Date.now();
    return next();
  },
  (next) => {
    context.user = context.req.headers["x-user"] ?? null;
    return next();
  },
];
