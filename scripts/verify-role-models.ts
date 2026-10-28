#!/usr/bin/env node
// Fail when the subagents skill's Models section gives a launcher role another model or thinking
// level than ROLE_DEFAULTS, the table the launcher reads, so the prose that explains each choice
// cannot drift from the code that makes it.
//
// usage: verify-role-models.ts [<SKILL.md>]    (default: agent/skills/subagents/SKILL.md)

import { readFileSync } from "node:fs";

import { ROLE_DEFAULTS, ROLES, type Role } from "../agent/skills/subagents/scripts/brief.ts";

const path =
  process.argv[2] ?? new URL("../agent/skills/subagents/SKILL.md", import.meta.url).pathname;

interface Bullet {
  readonly model: string;
  // The backticked roles after "runs", or every role no other bullet names.
  readonly roles: readonly Role[] | "every other role";
}

// A bullet that opens with a backticked model, cut at the first blank line so the paragraph
// after the list is not read as part of it.
function bullets(section: string): Bullet[] {
  return section.split(/\n(?=- )/).flatMap((item): Bullet[] => {
    const text = item.split("\n\n")[0] ?? "";
    const model = /^- `([^`]+)`/.exec(text)?.[1];
    const runs = text.split(/\bruns\s/)[1]?.trimStart();

    if (model === undefined || runs === undefined) return [];

    if (/^every\s+other\s+role\b/.test(runs)) return [{ model, roles: "every other role" }];

    const roles = [...runs.matchAll(/`([^`]+)`/g)].flatMap((match) => {
      const role = ROLES.find((candidate) => candidate === match[1]);

      return role === undefined ? [] : [role];
    });

    return [{ model, roles }];
  });
}

function problems(text: string): string[] {
  const section = text.split(/^## Models$/m)[1]?.split(/^## /m)[0];

  if (section === undefined) return [`${path} has no ## Models section`];

  const thinking = /\bruns at `--thinking ([^`]+)`/.exec(section)?.[1];

  const thinkingProblems =
    thinking === undefined
      ? [`${path}: the Models section states no \`--thinking\` level every subagent runs at`]
      : ROLES.filter((role) => ROLE_DEFAULTS[role].thinking !== thinking).map(
          (role) =>
            `${path}: the Models section runs every subagent at --thinking ${thinking}, but ROLE_DEFAULTS gives ${role} --thinking ${ROLE_DEFAULTS[role].thinking}`,
        );

  const list = bullets(section);
  const fallback = list.find(({ roles }) => roles === "every other role")?.model;

  const modelProblems = ROLES.flatMap((role) => {
    const named = list.flatMap(({ model, roles }) =>
      roles !== "every other role" && roles.includes(role) ? [model] : [],
    );

    const models = named.length > 0 || fallback === undefined ? named : [fallback];

    if (models.length === 0) return [`${path}: the Models section names no model for ${role}`];

    return models
      .filter((model) => model !== ROLE_DEFAULTS[role].model)
      .map(
        (model) =>
          `${path}: the Models section runs ${role} on ${model}, but ROLE_DEFAULTS gives ${ROLE_DEFAULTS[role].model}`,
      );
  });

  return [...thinkingProblems, ...modelProblems];
}

const found = problems(readFileSync(path, "utf8"));

for (const problem of found) process.stderr.write(`verify-role-models: ${problem}\n`);

if (found.length > 0) process.exitCode = 1;
