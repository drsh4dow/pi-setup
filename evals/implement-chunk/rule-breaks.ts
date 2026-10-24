// The implement-chunk invariant: the root writes only to its state folder and to scratch paths
// outside the run's repository, never to the repository, its branches, or its PRs. A port of
// `~/.local/state/pi-agent/pi-setup/implement-chunk/check-orchestrator.mjs` onto the shared
// session parser, which also unpacks the calls a codemode script made. Heredoc bodies are data
// (briefs, notes), not commands.

import { isAbsolute, resolve } from "node:path";
import { argument, parseSession } from "../lib/session.ts";

export interface Scope {
  /** The root's working directory, against which relative paths resolve. */
  readonly cwd: string;
  /** The run's scratch directory: it holds the repository and its worktrees, so `/tmp` is not blanket-allowed under it. */
  readonly scratch: string;
}

function allowed(path: string, scope: Scope): boolean {
  if (/\/\.local\/state\/pi-agent\//.test(path) || path === "/dev/null") return true;

  const absolute = isAbsolute(path) ? path : resolve(scope.cwd, path);

  return absolute.startsWith("/tmp/") && !absolute.startsWith(`${scope.scratch}/`);
}

/** Drops heredoc bodies, then expands `~` and simple `VAR=value` assignments. */
function normalize(command: string): string {
  let text = command.replaceAll(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, "\n");
  const vars = new Map<string, string>();

  for (const [, name, value] of text.matchAll(/(?:^|[\s;&])(\w+)=("[^"]*"|'[^']*'|\S+)/g)) {
    vars.set(name, value.replaceAll(/^["']|["']$/g, ""));
  }

  for (let round = 0; round < 3; round += 1) {
    text = text.replaceAll(/\$\{?(\w+)\}?/g, (match, name: string) => vars.get(name) ?? match);
  }

  return text.replaceAll(/(^|[\s='"])~(?=\/)/g, "$1/HOME");
}

const GIT_WRITE =
  /\bgit\s+(?:-C\s+\S+\s+)?(commit|push|merge|rebase|cherry-pick|revert|am|apply|stash|tag|reset|checkout|switch|restore|rm|mv|add|worktree\s+(?:add|remove|prune))\b/;

const GIT_BRANCH_WRITE =
  /\bgit\s+(?:-C\s+\S+\s+)?branch\s+(?!-a\b|-r\b|--list\b|--show-current\b|--contains\b|-v+\b|--format\b)(\S+)/;

const GH_WRITES = [
  /\bgh\s+pr\s+(create|merge|edit|ready|close|reopen|review|comment)\b/,
  /\bgh\s+api\b[^\n]*\/(pulls|git\/refs|contents|merges)\b[^\n]*(-X|--method)\s*(POST|PATCH|PUT|DELETE)/,
  /\bgh\s+api\s+graphql\b[^\n]*\b(mergePullRequest|updatePullRequest|createPullRequest|markPullRequestReadyForReview)\b/,
];

// The prompt sanctions detached scratch worktrees under /tmp for read-only probes.
const SCRATCH_WORKTREE =
  /\bgit\s+(?:-C\s+\S+\s+)?worktree\s+(?:add\s+(?:-q\s+)?--detach\s+(?:-q\s+)?|remove\s+(?:--force\s+)?)\/tmp\/\S+/g;

/** Shell words up to the first unquoted `;`, `&`, `|`, or newline, quotes removed. */
function words(text: string): string[] {
  const out: string[] = [];

  for (const [token] of text.matchAll(/'[^']*'|"[^"]*"|[;&|\n]|[^\s;&|'"]+/g)) {
    if (/^[;&|\n]$/.test(token)) break;

    out.push(token.replaceAll(/^['"]|['"]$/g, ""));
  }

  return out;
}

function commandBreaks(raw: string, scope: Scope): string[] {
  const command = normalize(raw).replaceAll(SCRATCH_WORKTREE, "");
  const out: string[] = [];
  const git = GIT_WRITE.exec(command) ?? GIT_BRANCH_WRITE.exec(command);

  if (git !== null) out.push(`git ${git[1]}`);

  for (const pattern of GH_WRITES) {
    const hit = pattern.exec(command);

    if (hit !== null) out.push(hit[0].slice(0, 80));
  }

  // Single-quoted strings, and one a truncated codemode argument leaves open, are blanked so a `>`
  // inside them is not read as a redirect; neither is an arrow `->`.
  for (const match of command
    .replaceAll(/'[^']*(?:'|$)/g, "''")
    .matchAll(/(?<![0-9&<=-])>>?\s*("?)(?<target>[^\s"&|;)]+)\1/g)) {
    const target = match.groups?.target ?? "";

    if (!allowed(target, scope)) out.push(`redirect to ${target}`);
  }

  for (const match of command.matchAll(/\b(?:sed|perl)\s+-i\S*\s+/g)) {
    const target = words(command.slice(match.index + match[0].length)).pop() ?? "";

    if (!allowed(target, scope)) out.push(`in-place edit of ${target}`);
  }

  return out;
}

/** Every write the root made outside its allowance, as `<tool>: <what>`. */
export function ruleBreaks(rootJsonl: string, scope: Scope): string[] {
  const breaks: string[] = [];

  for (const operation of parseSession(rootJsonl).operations) {
    const at = operation.nested ? `codemode ${operation.tool}` : operation.tool;

    if (operation.tool === "edit" || operation.tool === "write") {
      const path = argument(operation, "path") ?? "";

      if (!allowed(path, scope)) breaks.push(`${at}: writes ${path}`);
    } else if (operation.tool === "bash" || operation.tool === "bg_start") {
      for (const found of commandBreaks(argument(operation, "command") ?? "", scope))
        breaks.push(`${at}: ${found}`);
    }
  }

  return breaks;
}
