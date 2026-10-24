import type { Guards } from "./types.ts";

export const SEP = "\u0000";
export const edgeId = (from: string, to: string) => `${from}${SEP}${SEP}${to}`;

export function guarded(guards: Guards | undefined, label: string) {
  const words = guards?.get(label);
  return words && !words.has("") ? `${label} [${[...words].sort().join(" or ")}]` : label;
}
export const addGuard = (guards: Guards, label: string, words: string) => {
  if (!guards.has(label)) guards.set(label, new Set());
  guards.get(label)!.add(words);
};

export const frontMatter = (title?: string) => [
  "---",
  ...(title ? [`title: ${JSON.stringify(title)}`] : []),
  "config:",
  "  markdownAutoWrap: false",
  "  state:",
  "    useMaxWidth: false",
  "---",
];
