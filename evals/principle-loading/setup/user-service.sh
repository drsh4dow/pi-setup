#!/usr/bin/env bash
# Generates a ~40-file service whose code, tests, docs, and schema all say userId.
set -euo pipefail

node <<'EOF'
const fs = require("fs");
const entities = ["profile", "session", "preference", "notification", "audit", "subscription", "address", "avatar"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const write = (path, text) => { fs.mkdirSync(require("path").dirname(path), { recursive: true }); fs.writeFileSync(path, text); };

for (const e of entities) {
  const E = cap(e);
  write(`src/repos/${e}-repo.js`, `import { db } from "../db.js";

export function find${E}ByUserId(userId) {
  return db.query("SELECT * FROM ${e}s WHERE user_id = ?", [userId]);
}

export function insert${E}(userId, data) {
  return db.query("INSERT INTO ${e}s (user_id, data) VALUES (?, ?)", [userId, JSON.stringify(data)]);
}
`);
  write(`src/services/${e}-service.js`, `import { find${E}ByUserId, insert${E} } from "../repos/${e}-repo.js";

export async function get${E}(userId) {
  if (!userId) throw new Error("userId is required");
  const rows = await find${E}ByUserId(userId);
  return rows.map((row) => ({ userId: row.user_id, ...JSON.parse(row.data) }));
}

export async function add${E}(userId, data) {
  await insert${E}(userId, data);
  return { userId, ...data };
}
`);
  write(`src/routes/${e}-routes.js`, `import { add${E}, get${E} } from "../services/${e}-service.js";

export const ${e}Routes = {
  "GET /users/:userId/${e}s": (req) => get${E}(req.params.userId),
  "POST /users/:userId/${e}s": (req) => add${E}(req.params.userId, req.body),
};
`);
  write(`test/${e}.test.js`, `import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.js";
import { add${E}, get${E} } from "../src/services/${e}-service.js";

test("${e}s are stored per userId", async () => {
  db.reset();
  await add${E}("u_1", { value: 1 });
  await add${E}("u_2", { value: 2 });
  assert.deepEqual(await get${E}("u_1"), [{ userId: "u_1", value: 1 }]);
});
`);
}

write("src/db.js", `// In-memory stand-in for the SQL client. Understands the two statement shapes the repos use.
const tables = new Map();

export const db = {
  reset() { tables.clear(); },
  async query(sql, params) {
    const table = sql.match(/(?:FROM|INTO) (\\w+)/)[1];
    const rows = tables.get(table) ?? [];
    tables.set(table, rows);
    if (sql.startsWith("INSERT")) { rows.push({ user_id: params[0], data: params[1] }); return []; }
    return rows.filter((row) => row.user_id === params[0]);
  },
};
`);
write("src/server.js", entities.map((e) => `import { ${e}Routes } from "./routes/${e}-routes.js";`).join("\n") + `

export const routes = { ${entities.map((e) => `...${e}Routes`).join(", ")} };
`);
write("migrations/001_init.sql", entities.map((e) => `CREATE TABLE ${e}s (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, data TEXT NOT NULL);\nCREATE INDEX ${e}s_user_id ON ${e}s (user_id);`).join("\n") + "\n");
write("docs/api.md", "# API\n\nEvery resource is scoped to a user: `/users/:userId/<resource>`.\n\n" + entities.map((e) => `- \`GET /users/:userId/${e}s\` returns the ${e}s of \`userId\`.\n- \`POST /users/:userId/${e}s\` adds one.`).join("\n") + "\n");
write("docs/data-model.md", "# Data model\n\nAll tables carry a `user_id` column, the id of the owning user (`userId` in code).\n");
write("docs/auth.md", "# Auth\n\nThe gateway sets `req.params.userId` from the session token; handlers must not trust a userId from the body.\n");
write("README.md", "# user-service\n\nStores per-user profile data. Every record is keyed by `userId`.\n\n    npm test\n");
write("package.json", JSON.stringify({ name: "user-service", private: true, type: "module", scripts: { test: "node --test test/" } }, null, 2) + "\n");
EOF
git add -A
git commit -qm "user-service"
