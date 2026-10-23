export type Caller = { kind: "customer"; customerId: string } | { kind: "admin"; adminId: string };

/** Returns the caller a `Bearer <token>` header names, or undefined when it is missing, malformed, or unknown. */
export function authenticate(header: string | undefined, tokens: ReadonlyMap<string, Caller>): Caller | undefined {
  const token = /^Bearer (\S+)$/.exec(header ?? "")?.[1];
  if (token === undefined) return undefined;
  return tokens.get(token);
}

/** Returns whether `caller` may read and change something `owner` owns: admins always, customers their own. */
export function canAccess(caller: Caller, owner: { customerId: string }): boolean {
  return caller.kind === "admin" || caller.customerId === owner.customerId;
}
