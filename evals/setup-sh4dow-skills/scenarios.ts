export type AgentFile = "AGENTS.md" | "CLAUDE.md";

export interface Scenario {
  readonly fixture: string;
  /** The origin remote. Owners are names no one has registered, so a stray write fails. */
  readonly remote?: string;
  readonly agentFile: AgentFile;
  /** A pattern the issue-tracker record must match, naming how this tracker is reached. */
  readonly tracker: RegExp;
  /** Whether the run must seed a glossary whose terms occur in the code. */
  readonly glossary: boolean;
  /** Strings the standards record must contain, such as the guardrail script names. */
  readonly standards: readonly string[];
  /** An agent-file heading whose facts the record absorbs, so it must be gone. */
  readonly folded?: string;
}

export const PROMPT = `/skill:setup-sh4dow-skills

I'm away from the keyboard for this whole run and can't answer questions. Take your recommended answer for every section and every confirmation without stopping to ask. If you need me to choose which agent file to create, create AGENTS.md. If the repository has no code to seed a glossary from, skip the glossary.`;

export const scenarios: readonly Scenario[] = [
  {
    fixture: "storefront",
    remote: "git@github.com:sh4dow-eval-unregistered-7f3a/storefront.git",
    agentFile: "AGENTS.md",
    tracker: /\bgh issue\b/,
    glossary: true,
    standards: ["lint", "typecheck", "test", "CONTRIBUTING.md"],
    folded: "## Issue tracker",
  },
  {
    fixture: "ledger",
    remote: "git@gitlab.com:sh4dow-eval-unregistered-7f3a/ledger.git",
    agentFile: "CLAUDE.md",
    tracker: /\bglab issue\b/,
    glossary: true,
    standards: ["lint", "test"],
  },
  {
    fixture: "greenfield",
    agentFile: "AGENTS.md",
    tracker: /state folder/i,
    glossary: false,
    standards: [],
  },
];
