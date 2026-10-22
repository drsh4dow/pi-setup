import { context } from "./context.js";
import { MiddlewareChain } from "./middleware-chain.js";
import { routes } from "./routes.js";

export class HandlerAdapter {
  constructor() {
    this.chain = new MiddlewareChain();
  }

  invoke() {
    context.handler = routes[`${context.req.method} ${context.path}`];
    return this.chain.run();
  }
}
