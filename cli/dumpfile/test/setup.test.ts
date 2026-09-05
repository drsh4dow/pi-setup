import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const approval of ["", "expire dumpfile-prod uploads"]) {
	test(`setup ${approval ? "applies approved" : "skips unapproved"} retroactive retention`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "dumpfile-setup-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const bin = join(root, "bin");
		await mkdir(bin);
		for (const command of [
			"bun",
			"bunx",
			"xdg-open",
			"wslview",
			"explorer.exe",
			"open",
		]) {
			const path = join(bin, command);
			await writeFile(
				path,
				`#!/bin/bash
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$CALLS"
if [[ "$(basename "$0")" == bunx ]]; then
  case "$*" in
    'wrangler r2 bucket list') echo dumpfile-prod ;;
    'wrangler auth token --json') echo '{"type":"oauth","token":"synthetic"}' ;;
  esac
elif [[ "$(basename "$0")" == bun ]]; then
  cat >/dev/null
  [[ "$2" != check ]]
fi
`,
			);
			await chmod(path, 0o700);
		}
		const calls = join(root, "calls");
		const result = spawnSync(
			"bash",
			[new URL("../setup.sh", import.meta.url).pathname],
			{
				env: {
					...process.env,
					HOME: root,
					XDG_CONFIG_HOME: root,
					PATH: `${bin}:${process.env.PATH}`,
					CALLS: calls,
				},
				input: `\n0123456789abcdef0123456789abcdef\n0123456789abcdef0123456789abcdef\n${approval}\n\n\n`,
				encoding: "utf8",
			},
		);
		// Stop at the next human credential boundary, before deployment or uploads.
		assert.equal(result.status, 1, result.stdout + result.stderr);
		const commands = await readFile(calls, "utf8");
		assert.match(
			commands,
			/retention.ts check 0123456789abcdef0123456789abcdef/,
		);
		assert.equal(
			commands.includes("--expire-existing-uploads"),
			Boolean(approval),
		);
		assert.equal(commands.includes("wrangler deploy"), false);
		assert.match(result.stdout, /both R2 credentials are required/);
	});
}
