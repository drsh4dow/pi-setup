import { loadReportRows } from "./load.ts";

export function generateDailyReport(day: string): string {
  const rows = loadReportRows().filter((row) => row.createdAt.startsWith(day));
  const lines = rows.map((row) => `${row.orderId},${row.customer.email},${(row.totalCents / 100).toFixed(2)}`);
  return ["order_id,email,total", ...lines].join("\n");
}

if (import.meta.main) {
  console.log(generateDailyReport(process.argv[2] ?? new Date().toISOString().slice(0, 10)));
}
