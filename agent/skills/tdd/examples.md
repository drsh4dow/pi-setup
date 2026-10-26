# Good and bad tests

Paired examples for the [tdd](SKILL.md) skill. Each pair tests the same behavior, the first through the seam and the second through a shortcut that the two imagined edits in [principle-test-behavior-not-implementation](../principle-test-behavior-not-implementation/SKILL.md) catch. The code is TypeScript with Vitest names; the shapes carry to any language and runner.

## Through the interface, not an internal collaborator

```typescript
// GOOD: drives checkout and asserts what the caller sees
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});

// BAD: pins which internal collaborator did the work
test("checkout calls paymentService.process", async () => {
  const process = vi.spyOn(paymentService, "process");
  await checkout(cart, paymentMethod);
  expect(process).toHaveBeenCalledWith(cart.total);
});
```

Rename `process` or fold it into `checkout` and the second test fails while every caller sees the same result. Its name also describes how, not what.

## Read back through the interface, not a side channel

```typescript
// GOOD: the caller's own way of reading a user back
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});

// BAD: queries the table the code happens to write today
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});
```

The second test breaks when the table is renamed or split. It also passes when `createUser` stores the wrong name, because the query returns an empty array and `toBeDefined()` accepts it.

## Expected values from an independent source

```typescript
// GOOD: the expected value is a literal worked out by hand
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});

// BAD: recomputes the expected value the way the code does
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});
```

If `calculateTotal` has a bug, an expected value computed the same way has it too, so the second test passes by construction.

## Fakes only at system boundaries

The payment gateway sits outside the code, so the test passes in a fake one. What the gateway receives is behavior, because the gateway observes it.

```typescript
// GOOD: the gateway is a parameter, and the test asserts the charge it receives
test("checkout charges the cart total in cents", async () => {
  const charges: Charge[] = [];
  const gateway: PaymentGateway = {
    charge: async (charge) => {
      charges.push(charge);
      return { id: "ch_1" };
    },
  };
  await checkout(createCart([{ price: 12.5 }]), { gateway });
  expect(charges).toEqual([{ amountCents: 1250, currency: "usd" }]);
});

// BAD: patches the import, so the test is tied to where checkout builds its client
vi.mock("./stripe-client", () => ({
  StripeClient: vi.fn(() => ({ charge: vi.fn() })),
}));
```

To make that fake possible, pass the client in instead of constructing it inside the code, and give each external operation its own function:

```typescript
// GOOD: one function per operation, so each fake returns one shape
interface PaymentGateway {
  charge(charge: Charge): Promise<{ id: string }>;
  refund(chargeId: string): Promise<void>;
}

// BAD: one generic call, so every fake branches on the path
interface PaymentGateway {
  request(path: string, body: unknown): Promise<unknown>;
}
```

## Red for the intended reason

The first run of a new test must fail on its assertion. A failure from a missing export, a typo, or broken setup says nothing about the behavior.

```typescript
test("orders over $100 get 10% off", () => {
  expect(priceOrder([{ price: 120 }]).total).toBe(108);
});
```

- Wrong red: `TypeError: priceOrder is not a function`. The test never reached the assertion. Add a stub that compiles and ignores the rule, such as `total: sum(items)`, and rerun.
- Right red: `AssertionError: expected 120 to be 108`. The test reached the assertion and saw the discount missing, so the code that turns it green is the discount.
