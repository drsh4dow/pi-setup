import fs from "node:fs";
import path from "node:path";
import {
  blankStrings,
  definitions,
  ruleSentences,
  splitCommentsKeepingOffsets,
  tlaVariables,
} from "./lib.ts";
import type { RuleModule } from "./types.ts";

const EXTENDS_STATEMENT = /\bEXTENDS\s+(\w+(?:\s*,\s*\w+)*)/g;
const CONSTANT_STATEMENT = /\bCONSTANTS?\s+(\w+(?:\([^)]*\))?(?:\s*,\s*\w+(?:\([^)]*\))?)*)/g;
const DECLARED_NAME = /(\w+)(?:\([^)]*\))?/g;
const LOCAL_DEFINITION = /^LOCAL\s/;
const INSTANCE_STATEMENT =
  /^(LOCAL[ \t]+)?(?:([A-Za-z_]\w*)[ \t]*==\s*)?INSTANCE\s+(\w+)((?:[^\n]|\n(?=\s))*)/gm;
const SUBSTITUTION = /(\w+)\s*<-([\s\S]*?)(?=\w+\s*<-|$)/g;
const ALIAS = /^\s*([A-Za-z_]\w*(?:![A-Za-z_]\w*)*)\s*$/;

export function ruleBook(spec: string) {
  const modules = new Map<string, RuleModule>();
  const moduleOf = (file: string): RuleModule => {
    if (modules.has(file)) return modules.get(file)!;
    const module: RuleModule = { rules: new Map(), parameters: [] };
    modules.set(file, module);
    const text = fs.readFileSync(file, "utf8");
    const code = blankStrings(splitCommentsKeepingOffsets(text).code);
    const fileOf = (name: string) => path.join(path.dirname(file), `${name}.tla`);
    const inherited = new Map<string, string>();
    const instancedReads = new Map<string, string[]>();
    const localImports = new Set<string>();
    const take = (
      imported: string,
      { name, local, substitutions = new Map() }: { name?: string; local?: string; substitutions?: Map<string, string> },
    ) => {
      for (const [rule, entry] of moduleOf(imported).rules) {
        if (entry.local) continue;
        const key = name ? `${name}!${rule}` : rule;
        if (local) localImports.add(key);
        if (entry.sentence) inherited.set(key, entry.sentence);
        instancedReads.set(
          key,
          [...entry.reads].map((v) => substitutions.get(v) ?? v),
        );
      }
    };
    const parameters: string[] = [];
    for (const [, names] of code.matchAll(EXTENDS_STATEMENT))
      for (const extended of names
        .split(/\s*,\s*/)
        .map(fileOf)
        .filter(fs.existsSync)) {
        parameters.push(...moduleOf(extended).parameters);
        take(extended, {});
      }
    for (const [, names] of code.matchAll(CONSTANT_STATEMENT))
      parameters.push(...[...names.matchAll(DECLARED_NAME)].map(([, constant]) => constant));
    for (const [, local, name, instanced, clause] of code.matchAll(INSTANCE_STATEMENT))
      if (fs.existsSync(fileOf(instanced)))
        take(fileOf(instanced), {
          name,
          local,
          substitutions: new Map([...clause.matchAll(SUBSTITUTION)].map(([, v, e]) => [v, e])),
        });
    const written = ruleSentences(text);
    const { bare, defs, own, through } = definitions(text, instancedReads, parameters);
    module.parameters.push(...parameters, ...tlaVariables(bare));
    const sentenceOf = (rule: string, seen = new Set<string>()): string | undefined => {
      if (written.has(rule)) return written.get(rule);
      if (seen.has(rule)) return undefined;
      const d = defs.get(rule);
      if (!d) return inherited.get(rule);
      const alias = ALIAS.exec(bare.slice(d.from, d.to))?.[1];
      return alias ? sentenceOf(alias, seen.add(rule)) : undefined;
    };
    for (const [rule, entry] of own) {
      const d = defs.get(rule);
      module.rules.set(rule, {
        sentence: sentenceOf(rule),
        reads: through(entry).reads,
        local: d ? LOCAL_DEFINITION.test(bare.slice(d.at, d.from)) : localImports.has(rule),
      });
    }
    return module;
  };
  return moduleOf(path.resolve(spec)).rules;
}
