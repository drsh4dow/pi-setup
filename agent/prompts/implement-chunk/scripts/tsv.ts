// Plain tab-separated tables with a fixed header, so a state file stays readable and greppable
// without this CLI.

/** Input the command refuses, so it changed nothing. The CLI exits 2 with the message. */
export class Refusal extends Error {}

export interface Row {
  readonly line: number;
  readonly cells: readonly string[];
}

export function parseTsv(file: string, text: string, header: readonly string[]): Row[] {
  const lines = text.split("\n");

  if (lines.at(-1) === "") lines.pop();

  const expected = header.join("\t");

  if (lines[0] !== expected) {
    throw new Refusal(
      `${file}:1: the header differs from the expected tab-separated header:\n${expected}`,
    );
  }

  return lines.slice(1).map((raw, index) => {
    const line = index + 2;
    const cells = raw.split("\t");

    if (cells.length !== header.length) {
      throw new Refusal(`${file}:${line}: ${cells.length} columns, expected ${header.length}`);
    }

    return { line, cells };
  });
}

export function tsvLine(cells: readonly string[]): string {
  const broken = cells.find((cell) => /[\t\n\r]/.test(cell));

  if (broken !== undefined) {
    throw new Refusal(`a value holds a tab or a newline: ${JSON.stringify(broken)}`);
  }

  return cells.join("\t");
}
