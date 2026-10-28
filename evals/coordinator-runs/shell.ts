// Reads shell commands the way a shell would, enough to tell which words run as commands and
// which statement a word belongs to, without running them.

// Words that run the word after them as a command, such as `bash spawn.sh` or `exec pi-subagent`,
// and shell keywords a command can follow.
const PASS_THROUGH = new Set([
  "bash",
  "sh",
  "zsh",
  "node",
  "bun",
  "tsx",
  "exec",
  "nohup",
  "env",
  "command",
  "time",
  "timeout",
  "setsid",
  "stdbuf",
  "nice",
  "then",
  "do",
  "else",
  "if",
  "while",
  "until",
  "!",
  "{",
]);

export interface Word {
  /** Where the word starts in the command text. */
  readonly start: number;
  /** Where the word ends in the command text, one past its last character. */
  readonly end: number;
  /** The word with its quotes and escapes removed. */
  readonly text: string;
  /** The redirection operator the word is the target of, such as `>`, `>>`, or `2>&`. */
  readonly redirect: string | undefined;
}

/**
 * The command's simple commands, each the list of its words, split at unquoted `;`, `&&`,
 * `||`, `|`, `&`, parentheses, backticks, and line ends.
 */
export function simpleCommands(shell: string): Word[][] {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let redirect: string | undefined;
  let start = -1;
  let text = "";

  const endWord = (end: number) => {
    if (start < 0) return;

    words.push({ start, end, text, redirect });
    redirect = undefined;
    start = -1;
    text = "";
  };

  const endCommand = (end: number) => {
    endWord(end);

    if (words.length > 0) commands.push(words);

    words = [];
    redirect = undefined;
  };

  const extend = (index: number, char: string) => {
    if (start < 0) start = index;

    text += char;
  };

  for (let index = 0; index < shell.length; index++) {
    const char = shell[index];

    if (char === "'" || char === '"') {
      if (start < 0) start = index;

      const close = char === "'" ? shell.indexOf("'", index + 1) : closingDoubleQuote(shell, index);
      const quoted = shell.slice(index + 1, close < 0 ? shell.length : close);

      text += char === "'" ? quoted : quoted.replace(/\\(.)/g, "$1");
      index = close < 0 ? shell.length : close;
    } else if (char === "\\") {
      if (shell[index + 1] === "\n") endWord(index);
      else extend(index, shell[index + 1] ?? "");

      index++;
    } else if (char === "#" && start < 0) {
      const newline = shell.indexOf("\n", index);

      index = newline < 0 ? shell.length : newline - 1;
    } else if (char === " " || char === "\t") {
      endWord(index);
    } else if (char === ">" || char === "<" || (char === "&" && shell[index + 1] === ">")) {
      // A file descriptor number before the operator, as in `2>`, is part of it.
      let operator = "";

      if (start >= 0 && /^\d+$/.test(text)) {
        operator = text;
        start = -1;
        text = "";
      } else endWord(index);

      const rest = /^(?:&>>?|>>|>[|&]?|<[&]?)/.exec(shell.slice(index))?.[0] ?? char;

      redirect = operator + rest;
      index += rest.length - 1;
    } else if ("\n;&|()`".includes(char)) {
      endCommand(index);
    } else extend(index, char);
  }

  endCommand(shell.length);

  return commands;
}

/**
 * The positions of the words of a simple command that run as commands. A launcher named in
 * quoted text, as an argument, or as a redirection target, such as `cat > bin/spawn.sh`, runs
 * nothing.
 */
export function commandIndices(words: readonly Word[]): number[] {
  const found: number[] = [];
  let atCommand = true;
  let passThrough = false;

  words.forEach((word, index) => {
    if (word.redirect !== undefined || !atCommand) return;

    // An assignment before the command, or a pass-through word's flags and durations.
    if (/^[A-Za-z_]\w*=/.test(word.text)) return;

    if (passThrough && /^(?:-|\d)/.test(word.text)) return;

    found.push(index);
    passThrough = PASS_THROUGH.has(commandName(word));
    atCommand = passThrough;
  });

  return found;
}

/** The name a command word runs, without its directory. */
export const commandName = (word: Word) => word.text.split("/").pop() ?? "";

/** The value of a `--flag value` or `--flag=value` argument. */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));

  if (index < 0) return undefined;

  return args[index] === flag ? args[index + 1] : args[index].slice(flag.length + 1);
}

/** Codemode cuts long recorded arguments and marks the cut with an ellipsis. */
export const CUT = /(?:\.\.\.|…)$/;

function closingDoubleQuote(shell: string, open: number): number {
  for (let index = open + 1; index < shell.length; index++) {
    if (shell[index] === "\\") index++;
    else if (shell[index] === '"') return index;
  }

  return -1;
}

// A heredoc's body is data written to a file or a program's stdin, such as test code that
// mentions a launcher, so its lines are no command.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g;

/** The command with each heredoc's body taken out, keeping the rest of its opening line. */
export function withoutHeredocBodies(command: string): string {
  return command.replace(HEREDOC, "$3");
}

/**
 * The command's statements: split at unquoted `;`, `&&`, `||`, `&`, and line ends, a pipeline
 * staying one statement, each keeping the body of a heredoc it opens.
 */
export function statements(shell: string): string[] {
  const found: string[] = [];
  const heredocs: string[] = [];
  let start = 0;
  let quote: string | undefined;

  const cut = (end: number, next: number) => {
    const text = shell.slice(start, end);

    if (text.trim() !== "") found.push(text);

    start = next;
  };

  for (let index = 0; index < shell.length; index++) {
    const char = shell[index];

    if (quote !== undefined) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = undefined;
    } else if (char === "\\") {
      index++;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "<" && shell.startsWith("<<", index) && shell[index + 2] !== "<") {
      const opener = /^<<-?\s*(['"]?)(\w+)\1/.exec(shell.slice(index));

      if (opener) {
        heredocs.push(opener[2]);
        index += opener[0].length - 1;
      } else index++;
    } else if (char === "\n" && heredocs.length > 0) {
      // The statement runs on through the bodies of the heredocs its line opened.
      let end = index + 1;

      for (const tag of heredocs.splice(0)) {
        const terminator = new RegExp(`^\\s*${tag}\\s*$`, "m").exec(shell.slice(end));

        end = terminator ? end + terminator.index + terminator[0].length : shell.length;
      }

      cut(end, end);
      index = end - 1;
    } else if (char === "\n" || char === ";") {
      cut(index, index + 1);
    } else if ((char === "&" || char === "|") && shell[index + 1] === char) {
      cut(index, index + 2);
      index++;
    } else if (char === "&" && shell[index - 1] !== ">" && shell[index + 1] !== ">") {
      cut(index, index + 1);
    }
  }

  cut(shell.length, shell.length);

  return found;
}
