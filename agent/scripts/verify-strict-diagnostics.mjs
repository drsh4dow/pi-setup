import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = mkdtempSync(join(tmpdir(), "pi-strict-diagnostics-"));

const runExpectedFailure = (label, command, args) => {
	console.log(`\n${label}`);
	const result = spawnSync(command, args, {
		cwd: fixture,
		stdio: "inherit",
	});
	if (result.status === 0) {
		throw new Error(`${label} unexpectedly exited successfully`);
	}
	if (result.error) throw result.error;
};

try {
	symlinkSync(join(repository, "node_modules"), join(fixture, "node_modules"));
	writeFileSync(join(fixture, "package.json"), '{"type":"module"}\n');
	writeFileSync(
		join(fixture, "effect-suggestion.ts"),
		'import { Effect } from "effect";\nconst values = [1, 2];\nexport const result = Effect.all(values.map(Effect.succeed));\n',
	);
	writeFileSync(
		join(fixture, "tsconfig.json"),
		JSON.stringify({
			extends: join(repository, "tsconfig.json"),
			include: ["effect-suggestion.ts"],
		}),
	);
	writeFileSync(
		join(fixture, "biome-warning.ts"),
		`${Array.from({ length: 801 }, (_, index) => `export const line${index} = ${index};`).join("\n")}\n`,
	);

	runExpectedFailure(
		"Effect suggestion must fail typecheck",
		join(repository, "node_modules/.bin/tsc"),
		["--noEmit", "-p", "tsconfig.json"],
	);
	runExpectedFailure(
		"Biome warning must fail lint",
		join(repository, "node_modules/.bin/biome"),
		[
			"check",
			"biome-warning.ts",
			"--config-path",
			join(repository, "biome.json"),
			"--error-on-warnings",
		],
	);
} finally {
	rmSync(fixture, { recursive: true, force: true });
}
