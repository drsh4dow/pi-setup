#!/usr/bin/env bash
# Writes ~300 job logs (tens of MB) where a few jobs fail for a handful of causes.
set -euo pipefail

node <<'EOF'
const fs = require("fs");
fs.mkdirSync("logs", { recursive: true });
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const failures = {
  17: ["ERROR db: read ECONNRESET 10.0.4.12:5432 (db-replica-2)", "FATAL job aborted after 3 retries"],
  58: ["ERROR db: read ECONNRESET 10.0.4.12:5432 (db-replica-2)", "FATAL job aborted after 3 retries"],
  91: ["ERROR transform: column \"region\" does not exist in source table orders_eu", "FATAL job aborted"],
  133: ["ERROR db: read ECONNRESET 10.0.4.12:5432 (db-replica-2)", "FATAL job aborted after 3 retries"],
  160: ["WARN memory 7.8GiB / 8GiB", "FATAL process killed by signal 9 (OOMKilled)"],
  204: ["ERROR transform: column \"region\" does not exist in source table orders_eu", "FATAL job aborted"],
  251: ["ERROR upload: s3 PutObject AccessDenied for s3://reports-archive/2026/10/22/", "FATAL job aborted"],
  288: ["WARN memory 7.9GiB / 8GiB", "FATAL process killed by signal 9 (OOMKilled)"],
};
for (let job = 1; job <= 300; job++) {
  const id = String(job).padStart(3, "0");
  const lines = [`2026-10-22T01:00:00Z INFO job-${id} start`];
  const n = 1200 + Math.floor(rand() * 600);
  for (let i = 0; i < n; i++) {
    const t = new Date(Date.UTC(2026, 9, 22, 1, 0, 0) + i * 1000).toISOString();
    const r = rand();
    if (r < 0.01) lines.push(`${t} WARN job-${id} slow query took ${Math.floor(rand() * 4000) + 1000}ms`);
    else if (r < 0.015) lines.push(`${t} ERROR job-${id} http: retrying request to metrics-exporter (timeout)`);
    else lines.push(`${t} INFO job-${id} processed batch ${i} rows=${Math.floor(rand() * 5000)} cursor=${Math.floor(rand() * 1e9).toString(16)}`);
  }
  if (failures[job]) for (const f of failures[job]) lines.push(`2026-10-22T01:30:00Z ${f.split(" ")[0]} job-${id} ${f.split(" ").slice(1).join(" ")}`);
  else lines.push(`2026-10-22T01:30:00Z INFO job-${id} done exit=0`);
  fs.writeFileSync(`logs/job-${id}.log`, lines.join("\n") + "\n");
}
EOF
