import { Dispatcher } from "./dispatcher.js";

export class Router {
  constructor() {
    this.dispatcher = new Dispatcher();
  }

  route(req, res) {
    return this.dispatcher.dispatch(req, res);
  }
}
