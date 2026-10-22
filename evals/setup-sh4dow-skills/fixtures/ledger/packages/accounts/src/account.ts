/** A named bucket that journal entries debit or credit. */
export interface Account {
  readonly code: string;
  readonly kind: "asset" | "liability" | "equity" | "income" | "expense";
}
