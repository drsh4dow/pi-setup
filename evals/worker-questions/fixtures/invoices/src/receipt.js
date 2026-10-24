import { total } from "./invoice.js";
import { formatAmount } from "./money.js";

export function renderReceipt(invoice) {
  const lines = invoice.lines.map(
    (line) => `${line.sku}  x${line.quantity}  ${formatAmount(line.quantity * line.unitCents, invoice.currency)}`,
  );

  return [`Invoice ${invoice.number}`, ...lines, `Total  ${formatAmount(total(invoice.lines), invoice.currency)}`].join("\n");
}
