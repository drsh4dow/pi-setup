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

interface Word {
  /** Where the word starts in the command text. */
  readonly start: number;
  /** The word with its quotes and escapes removed. */
  readonly text: string;
}

/**
 * The words of a shell command that run as commands. A launcher named in quoted text, as an
 * argument, or as a redirection target, such as `cat > bin/spawn.sh`, runs nothing.
 */
export function commandWords(shell: string): Word[] {
  const words: Word[] = [];
  let atCommand = true;
  let passThrough = false;
  let redirectTarget = false;
  let start = -1;
  let text = "";

  const endWord = () => {
    if (start < 0) return;

    const word = { start, text };

    start = -1;
    text = "";

    if (redirectTarget) {
      redirectTarget = false;

      return;
    }

    if (!atCommand) return;

    // An assignment before the command, or a pass-through word's flags and durations.
    if (/^[A-Za-z_]\w*=/.test(word.text)) return;

    if (passThrough && /^(?:-|\d)/.test(word.text)) return;

    words.push(word);
    passThrough = PASS_THROUGH.has(word.text.split("/").pop() ?? "");
    atCommand = passThrough;
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
      if (shell[index + 1] === "\n") endWord();
      else extend(index, shell[index + 1] ?? "");

      index++;
    } else if (char === "#" && start < 0) {
      const newline = shell.indexOf("\n", index);

      index = newline < 0 ? shell.length : newline - 1;
    } else if (char === " " || char === "\t") {
      endWord();
    } else if (char === ">" || char === "<") {
      // A file descriptor number before the operator, as in `2>`, is part of it.
      if (start >= 0 && /^\d+$/.test(text)) {
        start = -1;
        text = "";
      } else endWord();

      redirectTarget = true;
    } else if (char === "&" && (shell[index - 1] === ">" || shell[index - 1] === "<")) {
      // `>&2` duplicates a descriptor; the target follows.
    } else if ("\n;&|()`".includes(char)) {
      endWord();
      atCommand = true;
      passThrough = false;
      redirectTarget = false;
    } else extend(index, char);
  }

  endWord();

  return words;
}

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
