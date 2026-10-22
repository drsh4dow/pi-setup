/** A request for payment. Posting it writes a balanced journal entry. */
export interface Invoice {
  readonly number: string;
  readonly customerAccount: string;
  readonly amountCents: number;
}
