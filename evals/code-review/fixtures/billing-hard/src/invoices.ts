import { applyBasisPoints, formatCents, sumCents, type Cents } from "./money.ts";
import type { Plan } from "./plans.ts";
import { err, ok, type Result } from "./result.ts";

export type InvoiceStatus = "draft" | "open" | "paid" | "void";

/** One charge on an invoice. `amountCents` is always positive, so a subtotal is never below any of its lines. */
export type InvoiceLine = {
  description: string;
  amountCents: Cents;
  periodStart: Date;
  periodEnd: Date;
};

export type Invoice = {
  id: string;
  /** Assigned at finalization, so null while the invoice is a draft. See docs/adr-001-invoice-numbers.md. */
  number: string | null;
  customerId: string;
  subscriptionId: string;
  status: InvoiceStatus;
  lines: readonly InvoiceLine[];
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  createdAt: Date;
  finalizedAt: Date | null;
  paidAt: Date | null;
  voidedAt: Date | null;
};

export type InvoiceError = { kind: "invalid_transition"; from: InvoiceStatus; to: InvoiceStatus };

/** Returns a draft invoice for `lines`, with tax at `taxRateBasisPoints` of the subtotal. */
export function draftInvoice(input: {
  id: string;
  customerId: string;
  subscriptionId: string;
  lines: readonly InvoiceLine[];
  taxRateBasisPoints: number;
  at: Date;
}): Invoice {
  const subtotalCents = sumCents(input.lines.map((line) => line.amountCents));
  const taxCents = applyBasisPoints(subtotalCents, input.taxRateBasisPoints);
  return {
    id: input.id,
    number: null,
    customerId: input.customerId,
    subscriptionId: input.subscriptionId,
    status: "draft",
    lines: input.lines,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    createdAt: input.at,
    finalizedAt: null,
    paidAt: null,
    voidedAt: null,
  };
}

/** Returns the line that bills `plan` for the period from `periodStart` to `periodEnd`. */
export function periodLine(plan: Plan, periodStart: Date, periodEnd: Date): InvoiceLine {
  return {
    description: `${plan.name} plan, ${formatCents(plan.priceCents)} per ${plan.interval}`,
    amountCents: plan.priceCents,
    periodStart,
    periodEnd,
  };
}

/** Returns the draft finalized as `open` under `number`. Fails unless the invoice is a draft. */
export function finalizeInvoice(invoice: Invoice, input: { number: string; at: Date }): Result<Invoice, InvoiceError> {
  if (invoice.status !== "draft") return err(invalidTransition(invoice.status, "open"));
  return ok({ ...invoice, status: "open", number: input.number, finalizedAt: input.at });
}

/** Returns an open invoice marked paid at `at`. Fails unless the invoice is open. */
export function markInvoicePaid(invoice: Invoice, input: { at: Date }): Result<Invoice, InvoiceError> {
  if (invoice.status !== "open") return err(invalidTransition(invoice.status, "paid"));
  return ok({ ...invoice, status: "paid", paidAt: input.at });
}

/** Returns an open invoice voided at `at`; its number stays taken. Fails unless the invoice is open. */
export function voidInvoice(invoice: Invoice, input: { at: Date }): Result<Invoice, InvoiceError> {
  if (invoice.status !== "open") return err(invalidTransition(invoice.status, "void"));
  return ok({ ...invoice, status: "void", voidedAt: input.at });
}

/** Returns the display form of an invoice sequence number, such as `INV-000042`. */
export function formatInvoiceNumber(sequence: number): string {
  return `INV-${String(sequence).padStart(6, "0")}`;
}

function invalidTransition(from: InvoiceStatus, to: InvoiceStatus): InvoiceError {
  return { kind: "invalid_transition", from, to };
}
