#!/usr/bin/env bash
# A feature branch with one commit adding CSV export, checked out.
set -euo pipefail

git checkout -qb feature/orders-csv-export

cat > src/reports/export.ts <<'EOF'
import { customers, orders } from "../db.ts";

export function exportOrdersCsv(status?: string): string {
  let csv = "id,customer,email,status,items,total\n";
  try {
    const all = [...orders.values()];
    for (const order of all) {
      const st = order.isCancelled ? "cancelled" : order.isShipped ? "shipped" : order.isPaid ? "paid" : "pending";
      if (status) {
        if (status !== "all") {
          if (st !== status) {
            continue;
          }
        }
      }
      const customer = [...customers.values()].find((c) => c.id === order.customerId);
      let total = 0;
      for (const item of order.items) {
        total = total + item.unitPriceCents * item.quantity;
      }
      const dup = all.filter((o) => o.customerId === order.customerId).length > 1 ? " (repeat)" : "";
      csv = csv + order.id + "," + (customer ? customer.name + dup : "guest") + "," + (customer?.email ?? order.guestEmail ?? "") + "," + st + "," + order.items.map((i) => i.name).join("|") + "," + (total / 100).toFixed(2) + "\n";
    }
  } catch (e) {
    console.log(e);
    return "";
  }
  return csv;
}
EOF

node -e '
const fs = require("fs");
let s = fs.readFileSync("src/server.ts", "utf8");
s = s.replace(
  "import { cancelOrder, listOrders, markPaid } from \"./orders/orders.ts\";",
  "import { cancelOrder, listOrders, markPaid } from \"./orders/orders.ts\";\nimport { exportOrdersCsv } from \"./reports/export.ts\";",
);
s = s.replace(
  "  const pay = url.pathname",
  "  if (req.method === \"GET\" && url.pathname === \"/orders.csv\") {\n    res.writeHead(200, { \"content-type\": \"text/csv\" });\n    res.end(exportOrdersCsv(url.searchParams.get(\"status\") || undefined));\n    return;\n  }\n\n  const pay = url.pathname",
);
fs.writeFileSync("src/server.ts", s);
'
git add -A
git commit -qm "Add CSV export of orders"
