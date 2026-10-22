#!/usr/bin/env bash
# Generates a callback-style db module and 12 handlers that use it.
set -euo pipefail

node <<'EOF'
const fs = require("fs");
fs.mkdirSync("src/handlers", { recursive: true });
fs.mkdirSync("test", { recursive: true });

fs.writeFileSync("src/db.js", `// Callback-style key-value store.
const data = new Map();

export function get(key, callback) {
  setImmediate(() => (data.has(key) ? callback(null, data.get(key)) : callback(new Error(\`missing \${key}\`))));
}

export function put(key, value, callback) {
  setImmediate(() => { data.set(key, value); callback(null); });
}

export function list(prefix, callback) {
  setImmediate(() => callback(null, [...data.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v)));
}
`);

const resources = ["user", "team", "project", "task", "comment", "label", "milestone", "invite", "webhook", "token", "audit", "setting"];
for (const r of resources) {
  fs.writeFileSync(`src/handlers/${r}.js`, `import * as db from "../db.js";

export function create${r[0].toUpperCase() + r.slice(1)}(input, callback) {
  if (!input.id) return callback(new Error("id required"));
  db.put("${r}:" + input.id, input, (err) => {
    if (err) return callback(err);
    db.get("${r}:" + input.id, (err, saved) => {
      if (err) return callback(err);
      callback(null, saved);
    });
  });
}

export function list${r[0].toUpperCase() + r.slice(1)}s(callback) {
  db.list("${r}:", (err, items) => {
    if (err) return callback(err);
    callback(null, items);
  });
}
`);
}

fs.writeFileSync("test/handlers.test.js", `import assert from "node:assert/strict";
import { test } from "node:test";
${resources.map((r) => `import * as ${r} from "../src/handlers/${r}.js";`).join("\n")}

const handlers = { ${resources.join(", ")} };

for (const [name, mod] of Object.entries(handlers)) {
  const Name = name[0].toUpperCase() + name.slice(1);
  test(\`\${name}: create then list\`, (_, done) => {
    mod["create" + Name]({ id: "1", name }, (err, saved) => {
      assert.ifError(err);
      assert.equal(saved.name, name);
      mod["list" + Name + "s"]((err, items) => {
        assert.ifError(err);
        assert.equal(items.length, 1);
        done();
      });
    });
  });
}
`);
EOF
git add -A
git commit -qm "Add handlers"
