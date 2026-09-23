// Run with node agent/skills/babysit-pr/test/queue.bench.mjs [module URL].
// Filesystem counters are separate from behavioral queue tests. No GitHub calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { queueEvents } = await import(
	process.argv[2] ?? "../scripts/babysit-pr.mjs"
);
const original = { readdirSync: fs.readdirSync, readFileSync: fs.readFileSync };
let counts;
try {
	for (const name of Object.keys(original))
		fs[name] = (...args) => {
			if (counts) counts[name]++;
			return original[name](...args);
		};
	syncBuiltinESMExports();
	for (const n of [100, 300, 600]) {
		const root = fs.mkdtempSync(join(tmpdir(), "pi-queue-bench-"));
		try {
			const paths = {
				events: join(root, "events"),
				eventFile: (id) => join(root, "events", `${id}.json`),
				ackFile: (id) => join(root, "acks", `${id}.json`),
			};
			fs.mkdirSync(paths.events);
			fs.mkdirSync(join(root, "acks"));
			const events = Array.from({ length: n }, (_, i) => {
				const key = `issue-comment:${i + 1}:20260101`;
				const id = createHash("sha256").update(key).digest("hex");
				return {
					version: 1,
					id,
					marker: `<!-- pi-event:${id} -->`,
					kind: "issue-comment",
					key,
					observedAt: "2026-01-01T00:00:00.000Z",
					pr: {
						number: 42,
						url: "https://github.com/acme/widgets/pull/42",
						baseRefName: "main",
						headRefName: "feature",
						baseRefOid: "base",
						headRefOid: "head",
					},
					payload: {
						comment: { id: i + 1, user: { login: "author" }, body: "feedback" },
					},
				};
			});
			for (const event of events)
				fs.writeFileSync(paths.eventFile(event.id), JSON.stringify(event));
			for (const acknowledged of [false, true]) {
				if (acknowledged)
					for (const event of events)
						fs.writeFileSync(paths.ackFile(event.id), "{}");
				counts = { readdirSync: 0, readFileSync: 0 };
				const added = queueEvents(paths, events);
				const result = {
					events: n,
					acknowledged,
					added: added.length,
					...counts,
				};
				counts = undefined;
				console.log(JSON.stringify(result));
				assert.equal(result.added, 0);
				assert.ok(
					result.readdirSync <= 1,
					"one event directory scan per batch",
				);
				assert.ok(
					result.readFileSync <= n,
					"at most one read per stored event",
				);
			}
		} finally {
			counts = undefined;
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
} finally {
	for (const name of Object.keys(original)) fs[name] = original[name];
	syncBuiltinESMExports();
}
