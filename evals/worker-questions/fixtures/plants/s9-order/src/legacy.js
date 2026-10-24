import { formatAmount } from "./money.js";

export function legacyTotalLine(cents) {
  return `TOTAL ${formatAmount(cents, "USD")}`;
}
