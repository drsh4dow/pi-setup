export type User = {
  id: string;
  name: string;
  email: string;
  paymentMethodId: string;
};

export type Invoice = {
  id: string;
  userId: string;
  amountCents: number;
  period: string;
  status: "open" | "paid" | "failed";
  attempts: number;
};

export const users = new Map<string, User>([
  ["u_1", { id: "u_1", name: "Ada", email: "ada@example.com", paymentMethodId: "pm_1" }],
]);

export const invoices = new Map<string, Invoice>();
