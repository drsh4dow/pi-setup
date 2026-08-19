import {
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_ROOM_RATIO = 0.3;
const MAX_REQUIRED_BYTES = 1024 ** 4;
const MAX_SCANNED_ENTRIES = 2_100_000;
const MAX_CANDIDATES = 100_000;
const MAX_PROCESSES = 65_536;
const MAX_FDS_PER_PROCESS = 4_096;
const MAX_PROTECTED_PATHS = 100_000;
const MAX_REPORTED_PATHS = 100;
const MAX_REPORTED_FAILURES = 20;

class RecoveryLimitError extends Error {}

function inside(parent, child) {
	return child === parent || child.startsWith(`${parent}${sep}`);
}

function recordLivePath(paths, directory, target) {
	if (!isAbsolute(target) || !inside(directory, target)) return;
	if (!paths.has(target) && paths.size >= MAX_PROTECTED_PATHS)
		throw new RecoveryLimitError(
			`Live paths exceed the ${MAX_PROTECTED_PATHS}-path recovery limit`,
		);
	paths.add(target);
}

function processIsRunning(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(
			error instanceof Error &&
			"code" in error &&
			error.code === "ESRCH"
		);
	}
}

function livePaths(directory, uid, explicitPaths) {
	const paths = new Set();
	for (const entry of explicitPaths)
		if (typeof entry === "string")
			recordLivePath(paths, directory, resolve(entry));
	recordLivePath(paths, directory, resolve(process.cwd()));
	let processes = [];
	try {
		processes = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry));
	} catch (error) {
		throw new Error(
			`Cannot inspect live processes: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (processes.length > MAX_PROCESSES)
		throw new Error(
			`Process count exceeds the ${MAX_PROCESSES}-process recovery limit`,
		);
	for (const pid of processes) {
		try {
			const status = readFileSync(`/proc/${pid}/status`, "utf8");
			if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== uid) continue;
			const cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
			recordLivePath(paths, directory, cwd);
			const descriptors = readdirSync(`/proc/${pid}/fd`);
			if (descriptors.length > MAX_FDS_PER_PROCESS)
				throw new RecoveryLimitError(
					`Process ${pid} exceeds the ${MAX_FDS_PER_PROCESS}-descriptor recovery limit`,
				);
			for (const fd of descriptors) {
				try {
					const target = readlinkSync(`/proc/${pid}/fd/${fd}`).replace(
						/ \(deleted\)$/,
						"",
					);
					recordLivePath(paths, directory, target);
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						(error.code === "ENOENT" || error.code === "EBADF")
					)
						continue;
					throw error;
				}
			}
		} catch (error) {
			if (error instanceof RecoveryLimitError) throw error;
		}
	}
	return paths;
}

function measureTree(target, uid, globalInodes, budget) {
	const stack = [target];
	const localInodes = new Set();
	let bytes = 0;
	let allOwned = true;
	while (stack.length > 0) {
		if (++budget.scanned > MAX_SCANNED_ENTRIES)
			throw new Error(
				`Temporary directory exceeds the ${MAX_SCANNED_ENTRIES}-entry recovery scan limit`,
			);
		const current = stack.pop();
		let stat;
		try {
			stat = lstatSync(current);
		} catch {
			allOwned = false;
			continue;
		}
		const inode = `${stat.dev}:${stat.ino}`;
		if (stat.uid === uid) {
			if (!localInodes.has(inode)) {
				localInodes.add(inode);
				bytes += stat.blocks * 512;
			}
			if (!globalInodes.has(inode)) {
				globalInodes.add(inode);
				budget.userBytes += stat.blocks * 512;
			}
		} else {
			allOwned = false;
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
		try {
			for (const entry of readdirSync(current))
				stack.push(join(current, entry));
		} catch {
			allOwned = false;
		}
	}
	return { bytes, allOwned };
}

function protectedEntries(directory, paths) {
	const entries = new Set();
	for (const target of paths) {
		const parts = relative(directory, target).split(sep);
		if (parts[0] === "pi-web-access-repos" && parts[1])
			entries.add(join(directory, parts[0], parts[1]));
		else if (parts[0]) entries.add(join(directory, parts[0]));
	}
	return entries;
}

function scan(directory, uid, protectedPaths, collectCandidates) {
	const budget = { scanned: 0, userBytes: 0 };
	const globalInodes = new Set();
	const candidates = [];
	const rootStat = lstatSync(directory);
	if (!rootStat.isDirectory())
		throw new Error(`${directory} is not a directory`);
	if (rootStat.uid === uid) {
		globalInodes.add(`${rootStat.dev}:${rootStat.ino}`);
		budget.userBytes += rootStat.blocks * 512;
	}
	const rootEntries = readdirSync(directory);
	if (rootEntries.length > MAX_CANDIDATES)
		throw new Error(
			`Temporary directory exceeds the ${MAX_CANDIDATES}-candidate recovery limit`,
		);
	for (const name of rootEntries) {
		const target = join(directory, name);
		const measured = measureTree(target, uid, globalInodes, budget);
		if (!collectCandidates || !measured.allOwned) continue;
		const stat = lstatSync(target);
		if (name === "pi-web-access-repos" && stat.isDirectory()) {
			const cloneEntries = readdirSync(target);
			if (cloneEntries.length > MAX_CANDIDATES)
				throw new Error(
					`Pi clone cache exceeds the ${MAX_CANDIDATES}-candidate recovery limit`,
				);
			for (const child of cloneEntries) {
				const childPath = join(target, child);
				const childMeasured = measureTree(childPath, uid, globalInodes, budget);
				if (!childMeasured.allOwned) continue;
				const pid = /^\d+$/.test(child) ? Number(child) : undefined;
				if (pid !== undefined && processIsRunning(pid)) continue;
				candidates.push({
					path: childPath,
					bytes: childMeasured.bytes,
					mtimeMs: lstatSync(childPath).mtimeMs,
					tier: pid === undefined ? 1 : 0,
				});
			}
			continue;
		}
		candidates.push({
			path: target,
			bytes: measured.bytes,
			mtimeMs: stat.mtimeMs,
			tier:
				/^pi-(?:bash|output)-.*\.log$/.test(name) ||
				name.startsWith("pi-editor-")
					? 0
					: 1,
		});
	}
	const protectedCandidates = protectedEntries(directory, protectedPaths);
	return {
		userBytes: budget.userBytes,
		scanned: budget.scanned,
		candidates: candidates
			.filter((candidate) => !protectedCandidates.has(candidate.path))
			.sort((left, right) =>
				left.tier !== right.tier
					? left.tier - right.tier
					: left.mtimeMs - right.mtimeMs,
			),
	};
}

export function recoverTempSpace(options) {
	if (process.platform !== "linux" || typeof process.getuid !== "function")
		return {
			supported: false,
			enough: false,
			reason: "Linux user ownership is unavailable",
		};
	const directory = resolve(options.directory);
	if (!inside(resolve("/tmp"), directory))
		throw new Error(
			"Automatic temporary-space deletion only operates under /tmp",
		);
	const requiredBytes = Number(options.requiredBytes);
	if (
		!Number.isSafeInteger(requiredBytes) ||
		requiredBytes < 0 ||
		requiredBytes > MAX_REQUIRED_BYTES
	)
		throw new Error(
			`requiredBytes must be an integer between 0 and ${MAX_REQUIRED_BYTES}`,
		);
	const uid = process.getuid();
	const protectedPaths = livePaths(
		directory,
		uid,
		options.protectedPaths ?? [],
	);
	const initial = scan(directory, uid, protectedPaths, true);
	const targetBytes =
		requiredBytes + Math.ceil(initial.userBytes * SAFE_ROOM_RATIO);
	let estimatedFreed = 0;
	let afterBytes = initial.userBytes;
	let deletedCount = 0;
	let escalated = false;
	const deletedPaths = [];
	const failures = [];
	for (const candidate of initial.candidates) {
		try {
			rmSync(candidate.path, { recursive: true, force: true });
			deletedCount++;
			escalated ||= candidate.tier > 0;
			estimatedFreed += candidate.bytes;
			if (deletedPaths.length < MAX_REPORTED_PATHS)
				deletedPaths.push(candidate.path);
		} catch (error) {
			if (failures.length < MAX_REPORTED_FAILURES)
				failures.push(
					`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`,
				);
		}
		if (estimatedFreed < targetBytes) continue;
		afterBytes = scan(directory, uid, protectedPaths, false).userBytes;
		if (initial.userBytes - afterBytes >= targetBytes) break;
		estimatedFreed = initial.userBytes - afterBytes;
	}
	if (deletedCount > 0)
		afterBytes = scan(directory, uid, protectedPaths, false).userBytes;
	const freedBytes = Math.max(0, initial.userBytes - afterBytes);
	return {
		supported: true,
		enough: freedBytes >= targetBytes,
		escalated,
		beforeBytes: initial.userBytes,
		afterBytes,
		targetBytes,
		freedBytes,
		deletedCount,
		deletedPaths,
		failureCount: failures.length,
		failures,
		scannedEntries: initial.scanned,
	};
}

if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		process.stdout.write(
			`${JSON.stringify(recoverTempSpace(JSON.parse(process.argv[2])))}\n`,
		);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
