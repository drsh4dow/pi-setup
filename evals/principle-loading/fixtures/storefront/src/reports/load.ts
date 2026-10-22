import { customers, orders, type Customer } from "../db.ts";

export type ReportRow = {
  orderId: string;
  customer: Customer;
  totalCents: number;
  createdAt: string;
};

export function loadReportRows(): ReportRow[] {
  return [...orders.values()]
    .filter((order) => order.isPaid && !order.isCancelled)
    .map((order) => ({
      orderId: order.id,
      customer: customers.get(order.customerId as string) as Customer,
      totalCents: order.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0),
      createdAt: order.createdAt,
    }));
}
