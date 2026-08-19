import {
	accessSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PATCHED_FILES = [
	"dist/core/bash-executor.js",
	"dist/core/compaction/compaction.js",
	"dist/core/diagnostics.d.ts",
	"dist/core/diagnostics.js",
	"dist/core/tools/output-accumulator.d.ts",
	"dist/core/tools/output-accumulator.js",
	"dist/modes/interactive/interactive-mode.js",
];

function packageVersion(root) {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (manifest.name !== "@earendil-works/pi-coding-agent")
		throw new Error(`Unexpected package at ${root}`);
	return manifest.version;
}

export function syncPiPatches(localRoot, targetRoot) {
	if (realpathSync(localRoot) === realpathSync(targetRoot)) return 0;
	const localVersion = packageVersion(localRoot);
	const targetVersion = packageVersion(targetRoot);
	if (localVersion !== targetVersion)
		throw new Error(
			`Cannot patch active Pi ${targetVersion} from local Pi ${localVersion}. Install matching versions first.`,
		);

	let copied = 0;
	for (const relative of PATCHED_FILES) {
		const source = join(localRoot, relative);
		const target = join(targetRoot, relative);
		if (!existsSync(source))
			throw new Error(`Patched Pi file is missing: ${source}`);
		if (existsSync(target) && readFileSync(source).equals(readFileSync(target)))
			continue;
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(source, target);
		copied++;
	}
	return copied;
}

function activePiPackage(localRoot) {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const executable = join(
			directory,
			process.platform === "win32" ? "pi.exe" : "pi",
		);
		try {
			accessSync(executable, constants.X_OK);
			const target = dirname(dirname(realpathSync(executable)));
			if (realpathSync(target) !== realpathSync(localRoot)) return target;
		} catch {}
	}
}

if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const local = join(root, "node_modules/@earendil-works/pi-coding-agent");
	const active = activePiPackage(local);
	if (!active) {
		console.log(
			"No external pi executable found on PATH; skipped active Pi patch sync",
		);
	} else {
		const copied = syncPiPatches(local, active);
		console.log(
			copied === 0
				? "Verified active Pi patches"
				: `Patched ${copied} active Pi files`,
		);
	}
}
