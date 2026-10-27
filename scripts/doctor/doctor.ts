#!/usr/bin/env node

// Checks this Pi setup the way a new terminal sees it, and prints the fix for each problem.
// SETUP.md runs it through `mise run doctor`. It changes nothing on the machine.
// Exit 0 when no check fails (warnings and skipped tiers are fine), 1 when a check fails, and 2
// when the doctor itself cannot run.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve, sep } from "node:path";

import {
  type Link,
  type MiseTool,
  type PackagesRead,
  type PiLoad,
  listMiseTools,
  probePi,
  readDeclaredPackages,
  readLink,
  readNewShell,
  readStoredLogins,
  readSystemPackages,
  realpathOrSelf,
  resolveCommand,
  runCommand,
} from "./probe.ts";

export const TIER_NAMES = ["core", "browser", "formal", "mail", "video"] as const;

export type TierName = (typeof TIER_NAMES)[number];

// Each tier is a folder under mise/ that `mise run setup <tier>` links into mise's global conf.d.
// `commands` are the programs it puts on PATH for the skills that run them.
export const TIERS = {
  core: { enables: "Pi with this config", commands: ["vp", "node", "pi", "gh", "tmux", "rg"] },
  browser: { enables: "the agent-browser skill", commands: ["agent-browser"] },
  formal: { enables: "the statechart skill and the TLA+ verification skills", commands: ["java"] },
  mail: { enables: "the mailbox skill", commands: ["himalaya"] },
  video: { enables: "the catchup-video skill", commands: ["uv", "ffmpeg"] },
} satisfies Record<TierName, { enables: string; commands: string[] }>;

// The web-search skill reads these through agent/mcp.json.
const KEYS = ["PERPLEXITY_API_KEY", "EXA_API_KEY"];

// `vp install` builds these through the prepare script, and the extensions run them.
const BUILT_CLIS = ["emit-to-pi", "pi-subagent", "dumpfile"];

export interface Finding {
  status: "ok" | "warn" | "fail" | "skip";
  check: string;
  detail: string;
  // A shell command that fixes the finding. Advice that is not a command goes in the detail.
  fix?: string;
}

// What every check reads: the machine as a new terminal sees it.
interface Machine {
  repo: string;
  home: string;
  configDir: string;
  dataDir: string;
  shell: string;
  env: Map<string, string>;
  shellEnv: NodeJS.ProcessEnv;
  path: string;
  // Where vp keeps the shims mise/core/mise.toml puts on PATH, including vp's own.
  vitePlusBin: string;
  // Whether a new terminal has mise's tools on PATH. Without it, every tool is missing for one reason.
  miseActive: boolean;
}

// mise installs the tiers' tools, and vp, which mise installs, adds its shims next to Node.js.
function fromSetup(machine: Machine, path: string) {
  return path.startsWith(machine.dataDir + sep) || path.startsWith(machine.vitePlusBin + sep);
}

// The leading newline keeps the line whole when the file's last line has no newline.
function appendLine(line: string, file: string) {
  return `printf '\\n%s\\n' '${line}' >> ${file}`;
}

// The startup file the shell from newShellArgs reads. Linux terminals start interactive bash,
// which reads ~/.bashrc. macOS terminals start login bash, which reads only the first of these
// that exists.
function bashStartupFile(home: string, platform: NodeJS.Platform) {
  if (platform !== "darwin") return "~/.bashrc";

  const login = [".bash_profile", ".bash_login", ".profile"].find((name) =>
    existsSync(join(home, name)),
  );

  return `~/${login ?? ".bash_profile"}`;
}

export function activationFix({
  shell,
  mise,
  platform,
  home,
}: {
  shell: string;
  mise: string;
  platform: NodeJS.Platform;
  home: string;
}) {
  switch (basename(shell)) {
    case "bash":
      return appendLine(`eval "$(${mise} activate bash)"`, bashStartupFile(home, platform));

    case "zsh":
      return appendLine(`eval "$(${mise} activate zsh)"`, "~/.zshrc");
    case "fish":
      return appendLine(`${mise} activate fish | source`, "~/.config/fish/config.fish");
    default:
      return undefined;
  }
}

// Every skill folder of this checkout must be among the skills Pi loads, and no extension may
// fail to load.
export function judgePiLoad({
  load,
  skillsDir,
  expectedSkills,
}: {
  load: PiLoad;
  skillsDir: string;
  expectedSkills: number;
}): Finding {
  if (load.errors.length > 0)
    return {
      status: "fail",
      check: "pi",
      detail: `Pi reports errors while it loads this config:\n${load.errors.join("\n")}`,
      fix: "mise run setup",
    };

  if (!load.listed)
    return { status: "fail", check: "pi", detail: "Pi in RPC mode did not list its commands" };

  const loaded = load.skillPaths.filter((path) => path.startsWith(skillsDir + sep)).length;

  if (loaded < expectedSkills)
    return {
      status: "fail",
      check: "pi",
      detail: `Pi loads ${loaded} of the ${expectedSkills} skills in ${skillsDir}. Pi reads ~/.pi/agent, so clone this repository to ~/.pi, as SETUP.md describes.`,
    };

  return {
    status: "ok",
    check: "pi",
    detail: `loads all ${expectedSkills} skills of this checkout`,
  };
}

// SETUP.md and scripts/ci/follow-doctor.sh read this layout: the status word at column 0, and a
// finding's fix on the next line as six spaces and "fix: ".
export function report(findings: Finding[]) {
  const lines = findings.map((finding) => {
    const label = finding.status === "fail" ? "FAIL" : finding.status;
    const detail = finding.detail.replaceAll("\n", "\n      ");
    const fix = finding.fix ? `\n      fix: ${finding.fix}` : "";

    return `${label.padEnd(5)} ${finding.check}: ${detail}${fix}`;
  });

  const failed = findings.filter((finding) => finding.status === "fail").length;
  const warned = findings.filter((finding) => finding.status === "warn").length;
  const warnings = warned === 0 ? "" : `, ${warned} warning${warned === 1 ? "" : "s"}`;
  lines.push(
    failed === 0
      ? `doctor: no check failed${warnings}`
      : `doctor: ${failed} failed${warnings}. Apply each fix, then run mise run doctor again.`,
  );

  return { text: lines.join("\n"), exitCode: failed === 0 ? 0 : 1 };
}

function checkShell(machine: Machine, mise: string): Finding {
  const name = basename(machine.shell);

  if (machine.miseActive)
    return { status: "ok", check: "shell", detail: `a new ${name} has mise's tools on PATH` };

  const fix = activationFix({
    shell: machine.shell,
    mise,
    platform: process.platform,
    home: machine.home,
  });

  const detail = `a new ${name} does not activate mise, so it finds none of the tools mise installed.`;

  if (!fix)
    return {
      status: "fail",
      check: "shell",
      detail: `${detail} Activate mise in the startup file of ${machine.shell}, as https://mise.jdx.dev/getting-started.html#activate-mise describes, then open a new terminal.`,
    };

  return {
    status: "fail",
    check: "shell",
    detail: `${detail} After the fix, open a new terminal.`,
    fix,
  };
}

interface Installed {
  tools: MiseTool[];
  packages: PackagesRead;
}

function checkTier(machine: Machine, tier: TierName, installed: Installed): Finding[] {
  const link: Link = readLink(
    join(machine.configDir, "conf.d", `pi-setup-${tier}`),
    join(machine.repo, "mise", tier),
  );

  const setup = tier === "core" ? "mise run setup" : `mise run setup ${tier}`;

  switch (link.kind) {
    case "absent":
      return tier === "core"
        ? [{ status: "fail", check: tier, detail: "not set up", fix: setup }]
        : [
            {
              status: "skip",
              check: tier,
              detail: `not set up; it enables ${TIERS[tier].enables}`,
              fix: setup,
            },
          ];
    case "elsewhere":
      return [
        {
          status: "fail",
          check: tier,
          detail: `conf.d/pi-setup-${tier} in ${machine.configDir} is ${link.target}, not this checkout's mise/${tier}. Move it aside, then run ${setup}.`,
        },
      ];
    case "linked":
      return checkLinkedTier(machine, tier, installed);
    default: {
      const unexpected: never = link;
      throw new Error(`Unexpected link: ${String(unexpected)}`);
    }
  }
}

function checkLinkedTier(machine: Machine, tier: TierName, installed: Installed): Finding[] {
  const own = installed.tools.filter((tool) => tool.tier === tier);
  const missing = own.filter((tool) => !tool.installed);

  if (own.length === 0)
    return [
      {
        status: "fail",
        check: tier,
        detail: "mise loads no tools from this tier",
        fix: "mise run setup",
      },
    ];

  if (missing.length > 0)
    return [
      {
        status: "fail",
        check: tier,
        detail: `not installed: ${missing.map((tool) => `${tool.tool}@${tool.version}`).join(", ")}`,
        fix: "mise run setup",
      },
    ];

  const findings: Finding[] = [];
  const { packages } = installed;

  const missingPackages =
    packages.kind === "read"
      ? readDeclaredPackages(join(machine.repo, "mise", tier, "mise.toml")).filter((key) => {
          const state = packages.states.get(key);

          return state !== undefined && state !== "installed";
        })
      : [];

  if (missingPackages.length > 0)
    findings.push({
      status: "fail",
      check: tier,
      detail: `system packages missing: ${missingPackages.join(", ")}. Installing them needs sudo.`,
      fix: "mise bootstrap packages apply --yes --update",
    });

  for (const command of machine.miseActive ? TIERS[tier].commands : []) {
    const path = resolveCommand(command, machine.path);

    if (!path)
      findings.push({
        status: "fail",
        check: tier,
        detail: `a new terminal does not find ${command}`,
        fix: "mise run setup",
      });
    else if (!fromSetup(machine, path))
      findings.push({
        status: "warn",
        check: tier,
        detail: `${command} resolves to ${path}, ahead of the version mise/${tier}/mise.toml pins. Remove that ${command}, or activate mise after the PATH entry that adds it.`,
      });
  }

  if (findings.length === 0) {
    const versions = own.map(
      (tool) => `${tool.tool.replace(/^github:[^/]+\//, "")} ${tool.version}`,
    );

    findings.push({ status: "ok", check: tier, detail: versions.join(", ") });
  }

  return [...findings, ...tierExtras(machine, tier)];
}

// Checks a tier needs beyond its tools being on PATH.
function tierExtras(machine: Machine, tier: TierName): Finding[] {
  switch (tier) {
    case "browser": {
      const agentBrowser = resolveCommand("agent-browser", machine.path);

      if (!agentBrowser) return [];

      const run = runCommand({
        command: agentBrowser,
        args: ["doctor"],
        env: machine.shellEnv,
        timeout: 120_000,
      });

      if (run.ok)
        return [{ status: "ok", check: "browser", detail: "agent-browser doctor passes" }];

      const failures = run.output
        .split("\n")
        .flatMap((line) => (/^\s*fail\b/.test(line) ? [line.trim()] : []));

      const detail = `agent-browser doctor fails: ${failures.join("; ") || run.output}`;

      if (process.platform !== "linux")
        return [
          { status: "fail", check: "browser", detail, fix: "mise exec -- agent-browser install" },
        ];

      // agent-browser installs Chrome's system libraries itself, but only through these managers.
      if (["apt-get", "dnf", "yum"].some((manager) => resolveCommand(manager, machine.path)))
        return [
          {
            status: "fail",
            check: "browser",
            detail,
            fix: "mise exec -- agent-browser install --with-deps",
          },
        ];

      return [
        {
          status: "fail",
          check: "browser",
          detail: `${detail}\nagent-browser installs Chrome's system libraries only with apt-get, dnf, or yum. Install the libraries it names with this machine's package manager, then run mise exec -- agent-browser install.`,
        },
      ];
    }

    case "core":
    case "video":
    case "formal":
    case "mail":
      return [];
    default: {
      const unexpected: never = tier;
      throw new Error(`Unexpected tier: ${String(unexpected)}`);
    }
  }
}

function checkInstall({ repo }: Machine): Finding {
  const required = [
    "node_modules",
    ...BUILT_CLIS.map((cli) => `.build/bin/${cli}`),
    "agent/settings.json",
  ];

  const missing = required.filter((path) => !existsSync(join(repo, path)));

  if (missing.length === 0)
    return {
      status: "ok",
      check: "install",
      detail: "dependencies, built CLIs, and agent/settings.json are in place",
    };

  return {
    status: "fail",
    check: "install",
    detail: `missing ${missing.join(", ")}`,
    fix: "mise run setup",
  };
}

function checkPi(machine: Machine): Finding {
  const pi = resolveCommand("pi", machine.path);

  if (!pi) return { status: "skip", check: "pi", detail: "no pi on PATH to start" };

  const skillsDir = realpathOrSelf(join(machine.repo, "agent", "skills"));

  const expectedSkills = readdirSync(skillsDir).filter((name) =>
    existsSync(join(skillsDir, name, "SKILL.md")),
  ).length;

  const run = probePi(pi, machine.shellEnv);

  if (run.kind === "failed") return { status: "fail", check: "pi", detail: run.reason };

  const load = { ...run.load, skillPaths: run.load.skillPaths.map(realpathOrSelf) };

  return judgePiLoad({ load, skillsDir, expectedSkills });
}

function checkLogin({ repo }: Machine): Finding {
  const providers = readStoredLogins(join(repo, "agent", "auth.json"));

  if (providers.length > 0)
    return { status: "ok", check: "login", detail: `Pi is logged in to ${providers.join(", ")}` };

  return {
    status: "warn",
    check: "login",
    detail:
      "Pi has no stored credentials yet, unless a provider's API key is set. Start pi and run /login.",
  };
}

function checkKeys({ env }: Machine): Finding {
  const missing = KEYS.filter((key) => !env.get(key));

  if (missing.length === 0)
    return { status: "ok", check: "keys", detail: `${KEYS.join(" and ")} are set` };

  return {
    status: "warn",
    check: "keys",
    detail: `a new terminal has no ${missing.join(" or ")}, which the web-search skill needs. Export them in your shell profile.`,
  };
}

function checkAgentSkills({ home, repo }: Machine): Finding {
  const link = readLink(join(home, ".agents", "skills"), join(repo, "agent", "skills"));

  switch (link.kind) {
    case "linked":
      return {
        status: "ok",
        check: "agent-skills",
        detail: "~/.agents/skills shares these skills with other agents",
      };
    case "absent":
      return {
        status: "skip",
        check: "agent-skills",
        detail: "no ~/.agents/skills, so agents that read it do not see these skills",
        fix: "mise run setup --link-agent-skills",
      };
    case "elsewhere":
      return {
        status: "skip",
        check: "agent-skills",
        detail: `~/.agents/skills is ${link.target}, which setup leaves alone. docs/development.md says how to merge it`,
      };
    default: {
      const unexpected: never = link;
      throw new Error(`Unexpected link: ${String(unexpected)}`);
    }
  }
}

function runDoctor(): Finding[] {
  const home = homedir();
  const findings: Finding[] = [];

  const mise =
    process.env.PI_SETUP_MISE || resolveCommand("mise", process.env.PATH ?? "") || "mise";

  const read = readNewShell(home);

  const own = new Map(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value] as const],
    ),
  );

  if (read.kind === "failed")
    findings.push({
      status: "fail",
      check: "shell",
      detail: `could not read the environment of a new terminal: ${read.reason}. The checks below use the doctor's own environment.`,
    });
  const shell = read.kind === "read" ? read.shell : { shell: process.env.SHELL ?? "sh", env: own };

  const dataDir =
    process.env.MISE_DATA_DIR ??
    join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "mise");

  const path = shell.env.get("PATH") ?? "";

  const machine: Machine = {
    repo: resolve(import.meta.dirname, "../.."),
    home,
    configDir:
      process.env.MISE_CONFIG_DIR ??
      join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "mise"),
    dataDir,
    shell: shell.shell,
    env: shell.env,
    shellEnv: Object.fromEntries(shell.env),
    path,
    vitePlusBin: join(home, ".local", "share", "vite-plus", "bin"),
    miseActive: path.split(delimiter).some((entry) => entry.startsWith(dataDir + sep)),
  };

  if (read.kind === "read") findings.push(checkShell(machine, mise));

  const mised = listMiseTools(mise);

  if (mised.kind === "failed")
    findings.push({ status: "fail", check: "mise", detail: mised.reason });
  const packages = readSystemPackages(mise);

  if (packages.kind === "failed")
    findings.push({ status: "fail", check: "mise", detail: packages.reason });

  const installed = { tools: mised.kind === "read" ? mised.tools : [], packages };

  for (const tier of TIER_NAMES) findings.push(...checkTier(machine, tier, installed));

  findings.push(
    checkInstall(machine),
    checkPi(machine),
    checkLogin(machine),
    checkKeys(machine),
    checkAgentSkills(machine),
  );

  return findings;
}

if (import.meta.main) {
  try {
    const { text, exitCode } = report(runDoctor());
    process.stdout.write(`${text}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    const said = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`doctor: could not run: ${said}\n`);
    process.exitCode = 2;
  }
}
