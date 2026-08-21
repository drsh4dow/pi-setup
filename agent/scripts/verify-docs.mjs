#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

const root = process.cwd();
const tracked = execFileSync("git", ["ls-files", "-z"], {
	cwd: root,
	encoding: "utf8",
})
	.split("\0")
	.filter(Boolean);
const errors = [];

function localTarget(raw) {
	const target = raw
		.trim()
		.replace(/^<|>$/g, "")
		.split(/\s+["']/)[0];
	if (!target || target.startsWith("#") || /^[a-z][a-z+.-]*:/i.test(target))
		return undefined;
	return decodeURIComponent(target.split(/[?#]/, 1)[0]);
}

for (const markdown of tracked.filter(
	(path) => extname(path).toLowerCase() === ".md",
)) {
	const text = readFileSync(resolve(root, markdown), "utf8");
	const targets = [
		...[...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]),
		...[...text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map((match) => match[1]),
	];
	for (const raw of targets) {
		const target = localTarget(raw);
		if (target && !existsSync(resolve(root, dirname(markdown), target))) {
			errors.push(`${markdown}: broken local link ${raw}`);
		}
	}
}

const inventory = [
	{
		heading: "Installed extensions",
		actual: tracked
			.map((path) => path.match(/^agent\/extensions\/([^/]+)\/index\.ts$/)?.[1])
			.filter(Boolean),
	},
	{
		heading: "Installed skills",
		actual: tracked
			.map((path) => path.match(/^agent\/skills\/([^/]+)\/SKILL\.md$/)?.[1])
			.filter(Boolean),
	},
	{
		heading: "Installed prompts",
		actual: tracked
			.map((path) => path.match(/^agent\/prompts\/([^/]+)\.md$/)?.[1])
			.filter(Boolean),
	},
	{
		heading: "Installed themes",
		actual: tracked
			.map((path) => path.match(/^agent\/themes\/([^/]+)\.json$/)?.[1])
			.filter(Boolean),
	},
];

const readme = readFileSync(resolve(root, "README.md"), "utf8");
for (const { heading, actual } of inventory) {
	const section = readme.match(
		new RegExp(`^### ${heading}\\s*$([\\s\\S]*?)(?=^###? |(?![\\s\\S]))`, "m"),
	);
	const documented = section
		? [...section[1].matchAll(/^[-|].*?`([^`]+)`/gm)].map((match) => match[1])
		: [];
	const expected = [...new Set(actual)].sort();
	const found = [...new Set(documented)].sort();
	if (JSON.stringify(expected) !== JSON.stringify(found)) {
		errors.push(
			`${heading}: tracked [${expected.join(", ")}], documented [${found.join(", ")}]`,
		);
	}
}

if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exitCode = 1;
} else {
	console.log(
		`Documentation verified (${tracked.filter((path) => path.endsWith(".md")).length} Markdown files).`,
	);
}
