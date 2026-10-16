import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  parseFrontmatter,
  type Skill,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem, Result } from "effect";

const DONE_LABEL = "Done";

const DISABLE_MODEL_INVOCATION_LINE = /^disable-model-invocation\s*:/;

const FRONTMATTER_OPEN = "---\n";

const FRONTMATTER_CLOSE = "\n---";

type SkillVisibility = {
  name: string;
  filePath: string;
  hidden: boolean;
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("skill-visibility", {
    description: "Toggle which skills are model-discoverable.",
    handler: (_args, ctx) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (!ctx.hasUI) {
            ctx.ui.notify("/skill-visibility requires interactive UI", "warning");

            return;
          }

          const skills = yield* listLoadedSkills(ctx.getSystemPromptOptions().skills ?? []);

          if (skills.length === 0) {
            ctx.ui.notify("No skills are currently loaded.", "info");

            return;
          }

          if (yield* chooseSkillVisibility(ctx, skills)) yield* reloadResources(ctx);
        }),
      ),
  });

  pi.on("session_start", (_event, ctx) =>
    Effect.runPromise(
      Effect.gen(function* () {
        if (!ctx.hasUI) return;

        const hiddenCommands = yield* listUserHiddenSkillCommands(pi.getCommands());

        if (hiddenCommands.size > 0) {
          ctx.ui.addAutocompleteProvider((current) => hideSkillCommands(current, hiddenCommands));
        }
      }),
    ),
  );
}

// Pi registers a `/skill:<name>` command for every skill and has no frontmatter
// to opt out, so skills marked `user-invokable: false` are dropped from slash
// command autocomplete here. Typing the full command still runs the skill.
const listUserHiddenSkillCommands = Effect.fn("listUserHiddenSkillCommands")(function* (
  commands: SlashCommandInfo[],
) {
  const hiddenCommands = new Set<string>();

  for (const command of commands) {
    if (command.source !== "skill") continue;

    if (!(yield* isUserInvokable(command.sourceInfo.path))) hiddenCommands.add(command.name);
  }

  return hiddenCommands;
});

function hideSkillCommands(
  current: AutocompleteProvider,
  hiddenCommands: ReadonlySet<string>,
): AutocompleteProvider {
  return {
    ...(current.triggerCharacters && { triggerCharacters: current.triggerCharacters }),
    getSuggestions: (lines, cursorLine, cursorCol, options) =>
      current.getSuggestions(lines, cursorLine, cursorCol, options).then((suggestions) => {
        if (!suggestions) return suggestions;

        const items = suggestions.items.filter((item) => !hiddenCommands.has(item.value));

        if (items.length === 0) return null;

        return { ...suggestions, items };
      }),
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
      current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
  };
}

const chooseSkillVisibility = Effect.fn("chooseSkillVisibility")(function* (
  ctx: ExtensionCommandContext,
  skills: SkillVisibility[],
) {
  let changed = false;

  for (let skill = yield* selectSkill(ctx, skills); skill;) {
    const hidden = !skill.hidden;

    const saved = yield* writeSkillVisibility(skill.filePath, hidden).pipe(Effect.result);

    if (Result.isFailure(saved)) {
      ctx.ui.notify(`Failed to save ${skill.name} visibility: ${saved.failure.message}`, "error");

      return changed;
    }

    skill.hidden = hidden;
    changed = true;
    ctx.ui.notify(
      `${skill.name} is now ${skill.hidden ? "hidden from model discovery" : "model-discoverable"}.`,
      "info",
    );
    skill = yield* selectSkill(ctx, skills);
  }

  return changed;
});

const selectSkill = Effect.fn("selectSkill")(function* (
  ctx: ExtensionCommandContext,
  skills: SkillVisibility[],
) {
  const choices = new Map(
    skills.map((skill) => [
      `${skill.hidden ? "○" : "●"} ${skill.name} — ${skill.hidden ? "hidden" : "discoverable"}`,
      skill,
    ]),
  );

  const selected = yield* Effect.promise(() =>
    ctx.ui.select("Skill visibility", [...choices.keys(), DONE_LABEL]),
  );

  return selected && selected !== DONE_LABEL ? choices.get(selected) : undefined;
});

const listLoadedSkills = Effect.fn("listLoadedSkills")(function* (skills: Skill[]) {
  const visibleSkills: SkillVisibility[] = [];

  for (const skill of skills) {
    const name = skill.name.trim().replace(/^skill:/, "");

    if (!name || !(yield* isUserInvokable(skill.filePath))) continue;
    visibleSkills.push({
      name,
      filePath: skill.filePath,
      hidden: skill.disableModelInvocation,
    });
  }

  return visibleSkills.toSorted((left, right) => left.name.localeCompare(right.name));
});

const isUserInvokable = Effect.fn("isUserInvokable")(function* (filePath: string) {
  return yield* FileSystem.FileSystem.use((fs) => fs.readFileString(filePath)).pipe(
    Effect.provide(BunFileSystem.layer),
    Effect.map((content) => parseFrontmatter(content).frontmatter["user-invokable"] !== false),
    Effect.orElseSucceed(() => true),
  );
});

const writeSkillVisibility = Effect.fn("writeSkillVisibility")(function* (
  filePath: string,
  hidden: boolean,
) {
  const content = yield* FileSystem.FileSystem.use((fs) => fs.readFileString(filePath));

  const nextContent = yield* Effect.try(() => setSkillVisibility(content, hidden));

  if (nextContent !== content)
    yield* FileSystem.FileSystem.use((fs) => fs.writeFileString(filePath, nextContent));
}, Effect.provide(BunFileSystem.layer));

function setSkillVisibility(content: string, hidden: boolean): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";

  const document = splitSkillDocument(content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));

  const nextContent = `---\n${setDisableModelInvocation(document.frontmatter, hidden)}\n---${document.body}`;

  return newline === "\n" ? nextContent : nextContent.replace(/\n/g, newline);
}

function splitSkillDocument(content: string) {
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

function setDisableModelInvocation(frontmatter: string, hidden: boolean): string {
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

const reloadResources = Effect.fn("reloadResources")(function* (ctx: ExtensionCommandContext) {
  const notify = ctx.ui.notify.bind(ctx.ui);
  notify("Reloading skills.", "info");
  yield* Effect.tryPromise(() => ctx.reload()).pipe(
    Effect.catch((error) =>
      Effect.sync(() =>
        notify(`Skill visibility saved, but reload failed: ${error.message}`, "warning"),
      ),
    ),
  );
});
