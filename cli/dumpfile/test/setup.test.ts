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

test("setup replaces a legacy cached proof URL without deleting the old upload", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dumpfile-setup-proof-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	await mkdir(bin);
	await mkdir(join(root, "dumpfile"));
	await writeFile(
		join(root, "dumpfile/config.env"),
		"DUMPFILE_TOKEN=synthetic\n",
	);
	await writeFile(
		join(root, "dumpfile/setup.env"),
		"DUMPFILE_VERIFIED_URL=https://files.drsh4dow.dev/old.png\n",
	);
	const fixture =
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415408d763f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082";
	for (const command of [
		"bun",
		"bunx",
		"curl",
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
case "$(basename "$0")" in
  bunx)
    case "$*" in
      'wrangler r2 bucket list') echo dumpfile-prod ;;
      'wrangler auth token --json') echo '{"type":"oauth","token":"synthetic"}' ;;
      'wrangler r2 bucket domain list dumpfile-prod') echo files.drsh4dow.dev ;;
    esac ;;
  bun)
    if [[ "$1" == */retention.ts ]]; then cat >/dev/null; else echo https://files.drsh4dow.dev/new.png; fi ;;
  curl)
    if [[ "$1" == *I ]]; then
      printf 'Content-Type: image/png\\nContent-Disposition: inline\\nX-Content-Type-Options: nosniff\\n'
      if [[ "$*" == *old.png* ]]; then echo 'Cache-Control: public, max-age=31536000, immutable'; else echo 'Cache-Control: no-store'; fi
    else
      printf '%s' '${fixture}' | xxd -r -p
    fi ;;
esac
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
				TMPDIR: root,
				PATH: `${bin}:${process.env.PATH}`,
				CALLS: calls,
			},
			input:
				"\n0123456789abcdef0123456789abcdef\n0123456789abcdef0123456789abcdef\nsynthetic-key\nsynthetic-secret\n\ny\ny\n",
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const commands = await readFile(calls, "utf8");
	assert.match(commands, /cli.ts upload/);
	assert.equal(commands.includes("object delete"), false);
	assert.match(
		await readFile(join(root, "dumpfile/setup.env"), "utf8"),
		/DUMPFILE_VERIFIED_URL=https:\/\/files.drsh4dow.dev\/new.png/,
	);
	assert.match(result.stdout, /verified https:\/\/files.drsh4dow.dev\/new.png/);
});
