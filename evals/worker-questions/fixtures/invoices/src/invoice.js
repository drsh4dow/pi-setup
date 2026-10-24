export function lineTotal(line) {
  return line.quantity * line.unitCents;
}

export function total(lines) {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0);
}
