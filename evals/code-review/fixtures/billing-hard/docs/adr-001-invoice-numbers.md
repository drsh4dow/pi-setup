# ADR 001: Invoice numbers are taken at finalization

Status: accepted

## Context

Tax rules in the markets we sell in require invoice numbers to form one sequence without
gaps, and an issued invoice must never change. Drafts are created and thrown away freely
(previews, failed validation), so numbering drafts would leave gaps.

## Decision

- An invoice gets its number when it is finalized, from `BillingStore.takeInvoiceNumber`,
  and only then. Drafts have `number: null`.
- Finalization is the only path from `draft` to `open`, and `issueInvoice` in
  `src/billing.ts` is the only caller of finalization. Every invoice a customer sees went
  through it.
- An open, paid, or void invoice is never edited. A mistake is corrected with a new invoice;
  an unpaid one is voided, and a voided invoice keeps its number.

## Consequences

Numbers are gap-free only as long as nothing takes a number without finalizing. Code that
needs a draft's future number has to wait for finalization.
