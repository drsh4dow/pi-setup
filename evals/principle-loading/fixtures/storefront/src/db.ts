export type Customer = {
  id: string;
  name: string;
  email: string;
};

export type LineItem = {
  sku: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
};

export type Order = {
  id: string;
  customerId?: string;
  guestEmail?: string;
  items: LineItem[];
  createdAt: string;
  isPaid: boolean;
  isShipped: boolean;
  isCancelled: boolean;
};

export const customers = new Map<string, Customer>([
  ["c_1", { id: "c_1", name: "Ada Lovelace", email: "ada@example.com" }],
  ["c_2", { id: "c_2", name: "Grace Hopper", email: "grace@example.com" }],
]);

export const orders = new Map<string, Order>([
  [
    "o_1",
    {
      id: "o_1",
      customerId: "c_1",
      items: [{ sku: "MUG", name: "Mug", unitPriceCents: 1200, quantity: 2 }],
      createdAt: "2026-10-21T09:12:00Z",
      isPaid: true,
      isShipped: false,
      isCancelled: false,
    },
  ],
  [
    "o_2",
    {
      id: "o_2",
      guestEmail: "guest@example.org",
      items: [{ sku: "TEE", name: "T-shirt", unitPriceCents: 2500, quantity: 1 }],
      createdAt: "2026-10-21T15:40:00Z",
      isPaid: true,
      isShipped: true,
      isCancelled: false,
    },
  ],
  [
    "o_3",
    {
      id: "o_3",
      customerId: "c_2",
      items: [{ sku: "CAP", name: "Cap", unitPriceCents: 1800, quantity: 1 }],
      createdAt: "2026-10-21T18:02:00Z",
      isPaid: false,
      isShipped: false,
      isCancelled: false,
    },
  ],
]);
