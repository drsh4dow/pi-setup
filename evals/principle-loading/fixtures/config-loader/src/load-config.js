import { readFileSync } from "node:fs";

const DEFAULTS = {
  port: 8080,
  logLevel: "info",
  database: { host: "localhost", port: 5432 },
};

export function loadConfig(path = process.env.APP_CONFIG ?? "config.json") {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  const config = {
    ...DEFAULTS,
    ...parsed,
    database: { ...DEFAULTS.database, ...parsed.database },
  };

  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error(`invalid port in ${path}: ${config.port}`);
  }

  return config;
}
