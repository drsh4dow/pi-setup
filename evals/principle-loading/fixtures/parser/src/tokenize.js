// Hand-written scanner. Replaces the regex tokenizer.
export function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " ") { i++; continue; }
    if (ch === "(" || ch === ")") { tokens.push({ type: ch }); i++; continue; }
    if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      tokens.push({ type: "string", value: input.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < input.length && input[j] !== " " && input[j] !== "(" && input[j] !== ")") j++;
    const word = input.slice(i, j);
    tokens.push(word === "AND" || word === "OR" || word === "NOT" ? { type: word } : { type: "term", value: word });
    i = j;
  }
  return tokens;
}
