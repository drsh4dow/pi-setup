import { readFile, writeFile } from "node:fs/promises";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  parseFrontmatter,
  type Skill,
} from "@earendil-works/pi-coding-agent";

const DONE_LABEL = "Done";
const DISABLE_MODEL_INVOCATION_LINE = /^disable-model-invocation\s*:/;
const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_CLOSE = "\n---";

type SkillVisibility = {
  name: string;
  filePath: string;
  hidden: boolean;
};

type SkillDocument = {
  frontmatter: string;
  body: string;
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("skill-visibility", {
    description: "Toggle which skills are model-discoverable.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/skill-visibility requires interactive UI", "warning");
        return;
      }

      const skills = await listLoadedSkills(
        ctx.getSystemPromptOptions().skills ?? [],
      );
      if (skills.length === 0) {
        ctx.ui.notify("No skills are currently loaded.", "info");
        return;
      }

      const changed = await chooseSkillVisibility(ctx, skills);
      if (changed) await reloadResources(ctx);
    },
  });
}

async function chooseSkillVisibility(
  ctx: ExtensionCommandContext,
  skills: SkillVisibility[],
): Promise<boolean> {
  let changed = false;
  let skill = await selectSkill(ctx, skills);

  while (skill) {
    const hidden = !skill.hidden;

    try {
      await writeSkillVisibility(skill.filePath, hidden);
    } catch (error) {
      ctx.ui.notify(
        `Failed to save ${skill.name} visibility: ${errorMessage(error)}`,
        "error",
      );
      return changed;
    }

    skill.hidden = hidden;
    changed = true;
    ctx.ui.notify(`${skill.name} is now ${stateLabel(skill)}.`, "info");

    skill = await selectSkill(ctx, skills);
  }

  return changed;
}

async function selectSkill(
  ctx: ExtensionCommandContext,
  skills: SkillVisibility[],
): Promise<SkillVisibility | undefined> {
  const choices = skillChoices(skills);
  const selected = await ctx.ui.select("Skill visibility", [
    ...choices.keys(),
    DONE_LABEL,
  ]);

  if (!selected || selected === DONE_LABEL) return undefined;
  return choices.get(selected);
}

function skillChoices(skills: SkillVisibility[]): Map<string, SkillVisibility> {
  const choices = new Map<string, SkillVisibility>();

  for (const skill of skills) {
    const marker = skill.hidden ? "○" : "●";
    const status = skill.hidden ? "hidden" : "discoverable";
    choices.set(`${marker} ${skill.name} — ${status}`, skill);
  }

  return choices;
}

async function listLoadedSkills(skills: Skill[]): Promise<SkillVisibility[]> {
  const visibleSkills: SkillVisibility[] = [];

  for (const skill of skills) {
    const name = normalizeSkillName(skill.name);
    if (!name || !(await isUserInvokable(skill.filePath))) continue;

    visibleSkills.push({
      name,
      filePath: skill.filePath,
      hidden: skill.disableModelInvocation,
    });
  }

  return visibleSkills.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

async function isUserInvokable(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, "utf-8");
    return parseFrontmatter(content).frontmatter["user-invokable"] !== false;
  } catch {
    return true;
  }
}

async function writeSkillVisibility(
  filePath: string,
  hidden: boolean,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const nextContent = setSkillVisibility(content, hidden);

  if (nextContent === content) return;
  await writeFile(filePath, nextContent, "utf-8");
}

function setSkillVisibility(content: string, hidden: boolean): string {
  const newline = detectNewline(content);
  const document = splitSkillDocument(normalizeNewlines(content));
  const frontmatter = setDisableModelInvocation(document.frontmatter, hidden);
  const nextContent = `---\n${frontmatter}\n---${document.body}`;

  return restoreNewlines(nextContent, newline);
}

function splitSkillDocument(content: string): SkillDocument {
  if (!content.startsWith(FRONTMATTER_OPEN)) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }

  const endIndex = content.indexOf(FRONTMATTER_CLOSE, FRONTMATTER_OPEN.length);
  if (endIndex === -1) {
    throw new Error("SKILL.md is missing a closing frontmatter delimiter");
  }

  const afterCloseIndex = endIndex + FRONTMATTER_CLOSE.length;
  const nextCharacter = content.at(afterCloseIndex);
  if (nextCharacter && nextCharacter !== "\n") {
    throw new Error("SKILL.md frontmatter delimiter must be on its own line");
  }

  return {
    frontmatter: content.slice(FRONTMATTER_OPEN.length, endIndex),
    body: content.slice(afterCloseIndex),
  };
}

function setDisableModelInvocation(
  frontmatter: string,
  hidden: boolean,
): string {
  const nextLine = `disable-model-invocation: ${hidden}`;
  const lines = frontmatter ? frontmatter.split("\n") : [];
  const nextLines: string[] = [];
  let found = false;

  for (const line of lines) {
    if (!DISABLE_MODEL_INVOCATION_LINE.test(line)) {
      nextLines.push(line);
      continue;
    }

    if (!found) nextLines.push(nextLine);
    found = true;
  }

  if (!found) nextLines.push(nextLine);
  return nextLines.join("\n");
}

async function reloadResources(ctx: ExtensionCommandContext): Promise<void> {
  const notify = ctx.ui.notify.bind(ctx.ui);
  notify("Reloading skills.", "info");

  try {
    await ctx.reload();
  } catch (error) {
    notify(
      `Skill visibility saved, but reload failed: ${errorMessage(error)}`,
      "warning",
    );
  }
}

function normalizeSkillName(name: string): string {
  return name.trim().replace(/^skill:/, "");
}

function stateLabel(skill: SkillVisibility): string {
  return skill.hidden ? "hidden from model discovery" : "model-discoverable";
}

function detectNewline(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreNewlines(content: string, newline: "\n" | "\r\n"): string {
  return newline === "\n" ? content : content.replace(/\n/g, newline);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
