export interface SeedIssue {
  readonly title: string;
  readonly body: string;
}

export interface Scenario {
  readonly skill: "to-spec" | "to-tickets";
  readonly prompt: string;
  /** Issues the tracker holds before the run, numbered from #1. */
  readonly seed: readonly SeedIssue[];
}

const AWAY =
  "I'm away from the keyboard and can't answer questions. Wherever the skill would check with me, take your recommended answer and carry on.";

const GIFT_CARD_SPEC = `## Problem Statement

Shoppers want to give the shop as a present, and the shop has no way to sell credit.

## Solution

Sell gift cards: a code holding a balance in cents that pays for orders at checkout.

## User Stories

1. As a shopper, I want to buy a gift card with a balance I choose, so that I can give it to someone.
2. As a recipient, I want to redeem a gift card at checkout, so that it pays part or all of my order.
3. As a recipient, I want to check a gift card's remaining balance by its code, so that I know what is left.

## Implementation Decisions

- A new gift card module owns codes and balances. Issuing a card comes first; redeeming and balance lookups need issued cards.
- Checkout takes an optional gift card and lowers the order total by what the card pays, never below zero.

## Testing Decisions

- Test through checkout and the gift card module's public functions, the highest existing seam.

## Out of Scope

- Refunds to gift cards, and expiry.`;

export const scenarios: readonly Scenario[] = [
  {
    skill: "to-spec",
    seed: [],
    prompt: `/skill:to-spec

What we settled in our discussion before this message:

- Shoppers can buy gift cards: a code holding a balance in cents, issued on purchase.
- At checkout a shopper can redeem a gift card. It pays part or all of the order total, and its balance goes down by what it paid.
- A shopper can check a gift card's remaining balance by its code.
- Gift cards never expire. Refunds to gift cards are out of scope.
- Test through checkout, the highest existing seam.

${AWAY}`,
  },
  {
    skill: "to-tickets",
    seed: [{ title: "Gift cards", body: GIFT_CARD_SPEC }],
    prompt: `/skill:to-tickets #1

${AWAY} Approve your proposed breakdown as it is.`,
  },
];
