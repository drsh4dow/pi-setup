// Sorts the words of one simple command by the expansions bash applies to them that the
// shell command reader in shell-command.ts does not reproduce, so the reader can mark
// what runs unread. readWord gives each word its first unread quoting form, such as a
// locale-quoted `$"…"`, and its unquoted characters, from which this module finds a
// pathname pattern that bash would expand. The reader expands braces itself (see
// brace-expansion.ts); a brace expansion it cannot reproduce reaches here unread.

import { runsWordsAt } from "./command-input.ts";
import { basename, commandArgv, isShell } from "./command-word.ts";
import type { WordForm } from "./shell-script.ts";

// A word that assigns, such as `x=*` or `a[0]=…`, as its unquoted characters show it.
// Bash expands no braces or patterns in an assignment.
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

// An unquoted pathname pattern: `*`, `?`, a bracket expression, or an extended glob.
const PATTERN = /[*?]|\[.+\]|[@!+]\(/;

// A brace sequence expression's body, such as `1..3`, `a..e`, or `0..10..2`.
const BRACE_SEQUENCE = /^(?:[+-]?\d+\.\.[+-]?\d+|[A-Za-z]\.\.[A-Za-z])(?:\.\.[+-]?\d+)?$/;

/** One word as the reader read it, for sorting its forms. */
export interface ReadWord {
  /** The first part of the word in a quoting form the reader does not read. */
  readonly unread: WordForm | undefined;
  /** The word's unquoted characters, with each quoted, escaped, or expanded part as `_`. */
  readonly unquoted: string;
}

/** The words of one simple command's argv that the reader does not read, by index. */
export interface ArgvForms {
  readonly unread: { readonly index: number; readonly form: WordForm }[];
  /** The words whose base name is an unquoted pattern. */
  readonly patterns: number[];
}

export function argvForms(): ArgvForms {
  return { unread: [], patterns: [] };
}

/** Whether `word`, the next word of a command whose words so far are `argv`, assigns. */
export function assignsAt(argv: readonly string[], word: ReadWord): boolean {
  return argv.every((done) => ASSIGNMENT_WORD.test(done)) && ASSIGNMENT_WORD.test(word.unquoted);
}

/**
 * Whether bash may expand a brace expansion in a word, given its unquoted characters: a
 * `{` not after `$` whose matching `}` encloses a comma or a sequence expression. The
 * reader asks only of a word whose expansion it cannot reproduce.
 */
export function mayExpandBraces(unquoted: string): boolean {
  for (let open = unquoted.indexOf("{"); open !== -1; open = unquoted.indexOf("{", open + 1)) {
    if (unquoted.charAt(open - 1) === "$") continue;

    let depth = 0;

    for (let index = open + 1; index < unquoted.length; index += 1) {
      const char = unquoted.charAt(index);

      if (char === "{") depth += 1;
      else if (char === "," && depth === 0) return true;
      else if (char === "}" && depth > 0) depth -= 1;
      else if (char === "}") {
        if (BRACE_SEQUENCE.test(unquoted.slice(open + 1, index))) return true;

        break;
      }
    }
  }

  return false;
}

/** Records the forms of `word`, the next word of a command whose words so far are `argv`. */
export function addWord(forms: ArgvForms, argv: readonly string[], word: ReadWord): void {
  const index = argv.length;

  // Bash expands no patterns in an assignment before the command word.
  const assigns = assignsAt(argv, word);

  if (word.unread !== undefined) forms.unread.push({ index, form: word.unread });

  const baseName = word.unquoted.slice(word.unquoted.lastIndexOf("/") + 1);

  if (!assigns && PATTERN.test(baseName)) forms.patterns.push(index);
}

// Whether a word of argv comes after node or a shell, which read it as a script file
// or as script text rather than run it as a command.
function afterInterpreter(argv: readonly string[], index: number): boolean {
  return argv.slice(0, index).some((word) => isShell(word) || basename(word) === "node");
}

/**
 * The form of the first unread word that is part of what the command runs, if any.
 * A brace expansion after node or a shell names a script file, not a command, and a
 * shell's script is read again as a script, where the same brace counts. A pattern
 * counts only in the command word or a wrapper's: the guard reads the patterns of the
 * arguments it judges, and a script's patterns when it reads the script.
 */
export function unreadRun(argv: readonly string[], forms: ArgvForms): WordForm | undefined {
  const commandWord = argv.length - commandArgv(argv).length;

  const runs = forms.unread.find(
    ({ index, form }) =>
      runsWordsAt(argv, [index]) && !(form === "brace" && afterInterpreter(argv, index)),
  );

  if (runs !== undefined) return runs.form;

  const runsPattern = forms.patterns.some(
    (index) => index <= commandWord && !afterInterpreter(argv, index),
  );

  return runsPattern ? "pattern" : undefined;
}
