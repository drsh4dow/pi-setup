import type { Order } from "./orders.ts";

/** In-memory orders, keyed by id. */
export class OrderStore {
  #orders = new Map<string, Order>();

  /** Returns the order with this id, or undefined if there is none. */
  get(id: string): Order | undefined {
    return this.#orders.get(id);
  }

  /** Stores the order, replacing any order with the same id. */
  save(order: Order): void {
    this.#orders.set(order.id, order);
  }
}
