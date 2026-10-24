export function formatAmount(cents, currency) {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
