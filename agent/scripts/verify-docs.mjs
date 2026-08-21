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
	.filter(Boolean)
	.filter((path) => existsSync(resolve(root, path)));
const errors = [];

function localReference(raw) {
	const target = raw
		.trim()
		.replace(/^<|>$/g, "")
		.split(/\s+["']/)[0];
	if (!target || /^[a-z][a-z+.-]*:/i.test(target) || target.startsWith("//"))
		return undefined;

	const hash = target.indexOf("#");
	const path = target.slice(0, hash === -1 ? undefined : hash).split("?", 1)[0];
	const fragment =
		hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
	return { path: decodeURIComponent(path), fragment };
}

function headingAnchors(markdown) {
	const anchors = new Set();
	const duplicates = new Map();
	for (const match of markdown.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
		const heading = match[1]
			.replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/<[^>]+>/g, "")
			.replace(/[`*_~]/g, "")
			.trim()
			.toLowerCase();
		const base = heading.replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
		const duplicate = duplicates.get(base) ?? 0;
		duplicates.set(base, duplicate + 1);
		anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
	}
	return anchors;
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
		const reference = localReference(raw);
		if (!reference) continue;
		const targetPath = reference.path
			? resolve(root, dirname(markdown), reference.path)
			: resolve(root, markdown);
		if (!existsSync(targetPath)) {
			errors.push(`${markdown}: broken local link ${raw}`);
			continue;
		}
		if (
			reference.fragment &&
			extname(targetPath).toLowerCase() === ".md" &&
			!headingAnchors(readFileSync(targetPath, "utf8")).has(reference.fragment)
		) {
			errors.push(`${markdown}: broken local anchor ${raw}`);
		}
	}
}

function extensionName(path) {
	return (
		path.match(/^agent\/extensions\/([^/]+)\/index\.ts$/)?.[1] ??
		path.match(/^agent\/extensions\/([^/]+)\.ts$/)?.[1]
	);
}

const extensionNames = [
	...new Set(tracked.map(extensionName).filter(Boolean)),
].sort();

for (const name of extensionNames) {
	const hasCredentialFreeTest = tracked.some(
		(path) =>
			(path.startsWith(`agent/extensions/${name}/test/`) &&
				path.endsWith(".test.ts") &&
				!path.endsWith("/e2e.test.ts")) ||
			path === `agent/extensions/test/${name}.test.ts`,
	);
	if (!hasCredentialFreeTest) {
		errors.push(
			`Installed extension ${name} has no tracked credential-free behavioral test`,
		);
	}
}

const inventory = [
	{ heading: "Installed extensions", actual: extensionNames },
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
