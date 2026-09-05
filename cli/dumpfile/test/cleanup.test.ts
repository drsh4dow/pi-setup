import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const fail of [false, true]) {
	test(`CLI fixtures are removed after ${fail ? "failed" : "successful"} assertions`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "dumpfile-cleanup-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const fixtures = join(root, "fixtures");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(fixtures);
		let source = await readFile(
			new URL("./cli.test.ts", import.meta.url),
			"utf8",
		);
		source = source.replaceAll(
			'"../src/',
			`"${new URL("../src/", import.meta.url).href}`,
		);
		if (fail)
			source = source.replace(
				"assert.equal(code, 0);",
				'assert.fail("injected assertion failure");',
			);
		const suite = join(root, "cli.test.ts");
		await writeFile(suite, source);
		const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: fixtures };
		delete env.NODE_TEST_CONTEXT;
		const result = spawnSync(process.execPath, ["--test", suite], {
			env,
			encoding: "utf8",
		});
		assert.equal(result.status, fail ? 1 : 0, result.stdout + result.stderr);
		if (fail) assert.match(result.stdout, /injected assertion failure/);
		assert.deepEqual(await readdir(fixtures), []);
	});
}
