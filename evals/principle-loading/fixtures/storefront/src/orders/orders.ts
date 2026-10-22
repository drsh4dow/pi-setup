import { orders, type LineItem, type Order } from "../db.ts";

let nextId = 100;

export function createOrder(customerId: string | undefined, guestEmail: string | undefined, items: LineItem[]): Order {
  const order: Order = {
    id: `o_${nextId++}`,
    customerId,
    guestEmail,
    items,
    createdAt: new Date().toISOString(),
    isPaid: false,
    isShipped: false,
    isCancelled: false,
  };
  orders.set(order.id, order);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

export function listOrders(): Order[] {
  return [...orders.values()];
}

export function markPaid(id: string) {
  const order = orders.get(id);
  if (!order) throw new Error("order not found");
  if (order.isCancelled) throw new Error("cannot pay a cancelled order");
  order.isPaid = true;
}

export function markShipped(id: string) {
  const order = orders.get(id);
  if (!order) throw new Error("order not found");
  if (!order.isPaid) throw new Error("cannot ship an unpaid order");
  if (order.isCancelled) throw new Error("cannot ship a cancelled order");
  order.isShipped = true;
}

export function cancelOrder(id: string) {
  const order = orders.get(id);
  if (!order) throw new Error("order not found");
  if (order.isShipped) throw new Error("cannot cancel a shipped order");
  order.isCancelled = true;
}
