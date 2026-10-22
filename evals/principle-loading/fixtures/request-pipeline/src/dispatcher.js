import { context } from "./context.js";
import { HandlerAdapter } from "./handler-adapter.js";

export class Dispatcher {
  constructor() {
    this.adapter = new HandlerAdapter();
  }

  dispatch(req, res) {
    context.req = req;
    context.res = res;
    context.path = new URL(req.url, "http://localhost").pathname;
    return this.adapter.invoke();
  }
}
