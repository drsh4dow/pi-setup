import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = mkdtempSync(join(tmpdir(), "pi-strict-diagnostics-"));

function runPackageScript(script) {
	return spawnSync("bun", ["run", script], {
		cwd: fixture,
		encoding: "utf8",
	});
}

function outputOf(result) {
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function requireCleanControl(label, script) {
	console.log(`\n${label}`);
	const result = runPackageScript(script);
	if (result.error) throw result.error;
	if (result.signal !== null)
		throw new Error(`${label} terminated by signal ${result.signal}`);
	if (result.status !== 0)
		throw new Error(`${label} failed:\n${outputOf(result)}`);
}

function requireDiagnostic(label, script, expected) {
	console.log(`\n${label}`);
	const result = runPackageScript(script);
	const output = outputOf(result);
	process.stdout.write(output);
	if (result.error) throw result.error;
	if (result.signal !== null)
		throw new Error(`${label} terminated by signal ${result.signal}`);
	if (result.status === null)
		throw new Error(`${label} did not report an exit status`);
	if (result.status === 0)
		throw new Error(`${label} unexpectedly exited successfully`);
	if (!expected.test(output))
		throw new Error(`${label} failed without the expected diagnostic`);
}

function makeDirectory(path) {
	mkdirSync(path, { recursive: true });
}

try {
	symlinkSync(join(repository, "node_modules"), join(fixture, "node_modules"));
	copyFileSync(join(repository, "package.json"), join(fixture, "package.json"));
	const biome = JSON.parse(
		readFileSync(join(repository, "biome.json"), "utf8"),
	);
	biome.vcs.enabled = false;
	writeFileSync(join(fixture, "biome.json"), `${JSON.stringify(biome)}\n`);

	for (const path of [
		"agent/extensions",
		"agent/lib",
		"agent/scripts",
		"agent/skills/babysit-pr/scripts",
		"agent/skills/babysit-pr/test",
		"cli/dumpfile/src",
		"cli/dumpfile/test",
	])
		makeDirectory(join(fixture, path));

	writeFileSync(
		join(fixture, "tsconfig.json"),
		JSON.stringify({
			extends: join(repository, "tsconfig.json"),
			include: ["agent/extensions/**/*.ts"],
		}),
	);
	writeFileSync(
		join(fixture, "cli/dumpfile/tsconfig.json"),
		JSON.stringify({
			extends: "../../tsconfig.json",
			include: ["src/**/*.ts"],
		}),
	);
	writeFileSync(
		join(fixture, "agent/extensions/clean.ts"),
		"export const clean = true;\n",
	);
	writeFileSync(
		join(fixture, "cli/dumpfile/src/clean.ts"),
		"export const clean = true;\n",
	);

	requireCleanControl("Clean fixture must pass typecheck", "typecheck");
	requireCleanControl("Clean fixture must pass check", "check");

	writeFileSync(
		join(fixture, "agent/extensions/effect-suggestion.ts"),
		'import { Effect } from "effect";\nconst values = [1, 2];\nexport const result = Effect.all(values.map(Effect.succeed));\n',
	);
	requireDiagnostic(
		"Effect suggestion must fail typecheck",
		"typecheck",
		/suggestion TS377113:.*Effect\.forEach/s,
	);
	rmSync(join(fixture, "agent/extensions/effect-suggestion.ts"));

	writeFileSync(
		join(fixture, "agent/extensions/biome-warning.ts"),
		`${Array.from({ length: 801 }, (_, index) => `export const line${index} = ${index};`).join("\n")}\n`,
	);
	requireDiagnostic(
		"Biome warning must fail check",
		"check",
		/lint\/style\/noExcessiveLinesPerFile/,
	);
} finally {
	rmSync(fixture, { recursive: true, force: true });
}
