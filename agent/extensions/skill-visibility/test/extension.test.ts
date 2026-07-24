import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
  Skill,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

test("omits skills that users cannot invoke from the visibility picker", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skill-visibility-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const skills = [
    ["automatic-only", "user-invokable: false\n"],
    ["explicitly-visible", "user-invokable: true\n"],
    ["visible-by-default", ""],
  ] as const;
  await Promise.all(
    skills.map(async ([name, visibility]) => {
      const filePath = join(directory, `${name}.md`);
      await writeFile(
        filePath,
        `---\nname: ${name}\ndescription: Test skill.\n${visibility}---\n`,
      );
    }),
  );

  let handler: RegisteredCommand["handler"] | undefined;
  extension({
    registerCommand(name: string, command: RegisteredCommand) {
      assert.equal(name, "skill-visibility");
      handler = command.handler;
    },
  } as unknown as ExtensionAPI);
  assert.ok(handler);

  let choices: string[] = [];
  const loadedSkills = skills.map(([name]) => ({
    name,
    filePath: join(directory, `${name}.md`),
    disableModelInvocation: false,
  })) as Skill[];
  await handler("", {
    hasUI: true,
    getSystemPromptOptions: () => ({ skills: loadedSkills }),
    ui: {
      notify() {},
      select: async (_title: string, options: string[]) => {
        choices = options;
        return "Done";
      },
    },
  } as unknown as ExtensionCommandContext);

  assert.deepEqual(choices, [
    "● explicitly-visible — discoverable",
    "● visible-by-default — discoverable",
    "Done",
  ]);
});
