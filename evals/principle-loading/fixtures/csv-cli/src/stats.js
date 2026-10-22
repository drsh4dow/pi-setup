export function parseCsv(text) {
  const [header, ...lines] = text.trim().split("\n");
  const columns = header.split(",");
  return lines.map((line, index) => {
    const cells = line.split(",");
    if (cells.length !== columns.length) throw new Error(`bad row ${index}`);
    return Object.fromEntries(columns.map((name, i) => [name, cells[i]]));
  });
}

export function summarize(rows, column) {
  const values = rows.map((row) => Number(row[column]));
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
}
