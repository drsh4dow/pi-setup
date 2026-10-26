// Only an explicit `user-invokable: false` hides a skill from /skill:. verify-docs reads the
// inventory's Who column with the same rule.
export function allowsUserInvocation(frontmatter: {
  readonly "user-invokable"?: unknown;
}): boolean {
  return frontmatter["user-invokable"] !== false;
}
