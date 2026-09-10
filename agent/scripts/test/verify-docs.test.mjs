import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const checker = new URL("../verify-docs.mjs", import.meta.url).pathname;

function repository(t, readme, extraFiles = {}) {
	const root = mkdtempSync(join(tmpdir(), "verify-docs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const files = {
		"README.md": readme,
		"agent/extensions/example/index.ts": "",
		"agent/extensions/example/test/extension.test.ts": "",
		"agent/skills/example/SKILL.md": "# Example\n",
		"agent/prompts/example.md": "# Example\n",
		"agent/themes/example.json": "{}\n",
		...extraFiles,
	};

	for (const [path, contents] of Object.entries(files)) {
		const destination = join(root, path);
		mkdirSync(join(destination, ".."), { recursive: true });
		writeFileSync(destination, contents);
	}

	execFileSync("git", ["init", "--quiet"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });

	return root;
}

const validReadme = `# Setup

### Installed extensions

- \`example\`

### Installed skills

- \`example\`

### Installed prompts

- \`example\`

### Installed themes

- \`example\`
`;

function run(root) {
	return spawnSync(process.execPath, [checker], {
		cwd: root,
		encoding: "utf8",
	});
}

test("accepts matching tracked inventory and resolving links", (t) => {
	const root = repository(t, `${validReadme}\n[Guide](docs/guide.md#start)\n`, {
		"docs/guide.md": "# Start\n\n[Setup](../README.md)\n",
	});

	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
});

test("ignores example links and headings inside fenced code", (t) => {
	const root = repository(t, validReadme, {
		"docs/guide.md": [
			"````md",
			"```md",
			"[Example](missing.md)",
			"```",
			"````",
			"   ~~~md",
			"[example]: also-missing.md",
			"# Start",
			"   ~~~~",
			"# Start",
			"[Real](#start)",
		].join("\n"),
	});

	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
});

test("still checks links after a fenced example", (t) => {
	const root = repository(t, validReadme, {
		"docs/guide.md": "```md\n[Example](ignored.md)\n```\n[Real](missing.md)\n",
	});

	const result = run(root);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /missing\.md/);
	assert.doesNotMatch(result.stderr, /ignored\.md/);
});

test("reports a broken link in any tracked Markdown file", (t) => {
	const root = repository(t, validReadme, {
		"docs/guide.md": "[Missing](nested/nope.md)\n",
	});

	const result = run(root);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /docs\/guide\.md.*nested\/nope\.md/);
});

test("reports broken same-file and cross-file Markdown anchors", (t) => {
	const root = repository(t, `${validReadme}\n[Missing](#absent)\n`, {
		"docs/guide.md": "# Present\n\n[Missing](../README.md#also-absent)\n",
	});

	const result = run(root);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /README\.md.*#absent/);
	assert.match(result.stderr, /docs\/guide\.md.*README\.md#also-absent/);
});

test("ignores tracked Markdown removed from the working tree", (t) => {
	const root = repository(t, validReadme, { "docs/removed.md": "# Removed\n" });
	rmSync(join(root, "docs/removed.md"));
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
});

test("reports a shipped extension without a credential-free test", (t) => {
	const root = repository(t, validReadme);
	rmSync(join(root, "agent/extensions/example/test/extension.test.ts"));
	const result = run(root);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /example.*credential-free behavioral test/);
});

test("includes directly tracked extension files in the inventory", (t) => {
	const root = repository(
		t,
		validReadme.replace("- `example`", "- `direct`\n- `example`"),
		{
			"agent/extensions/direct.ts": "",
			"agent/extensions/test/direct.test.ts": "",
		},
	);

	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
});

test("reports README inventory drift from tracked components", (t) => {
	const root = repository(
		t,
		validReadme.replace(
			"- `example`\n\n### Installed skills",
			"- `missing`\n\n### Installed skills",
		),
	);

	const result = run(root);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Installed extensions.*example.*missing/s);
});
