export interface Posting {
  readonly account: string;
  readonly debitCents: number;
  readonly creditCents: number;
}

/** A journal entry balances when debits equal credits. */
export function balances(postings: readonly Posting[]) {
  const debit = postings.reduce((sum, posting) => sum + posting.debitCents, 0);
  const credit = postings.reduce((sum, posting) => sum + posting.creditCents, 0);

  return debit === credit;
}
