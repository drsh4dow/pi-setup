import { tokenize } from "./tokenize.js";

const cache = new Map();

export function parse(input) {
  if (cache.has(input)) return cache.get(input);
  const tokens = tokenize(input);
  let pos = 0;

  function expr() {
    let left = unary();
    while (tokens[pos]?.type === "AND" || tokens[pos]?.type === "OR") {
      const op = tokens[pos++].type;
      left = { op, left, right: unary() };
    }
    return left;
  }

  function unary() {
    if (tokens[pos]?.type === "NOT") { pos++; return { op: "NOT", operand: unary() }; }
    if (tokens[pos]?.type === "(") { pos++; const inner = expr(); pos++; return inner; }
    return tokens[pos++];
  }

  const ast = expr();
  cache.set(input, ast);
  return ast;
}
