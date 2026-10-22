import { context } from "./context.js";
import { middlewares } from "./middlewares.js";

export class MiddlewareChain {
  run() {
    context.index = 0;
    return this.next();
  }

  next() {
    const middleware = middlewares[context.index++];
    if (middleware) return middleware(() => this.next());
    if (!context.handler) {
      context.res.writeHead(404).end();
      return;
    }
    return context.handler();
  }
}
