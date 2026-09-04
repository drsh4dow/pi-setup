import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recoverTempSpace } from "../../scripts/recover-temp-space.mjs";

const roots: string[] = [];
test.afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-temp-recovery-test-"));
	roots.push(root);
	return root;
}

function file(
	root: string,
	name: string,
	ageMinutes: number,
	bytes = 256 * 1024,
) {
	const target = join(root, name);
	writeFileSync(target, Buffer.alloc(bytes, 1));
	const modified = new Date(Date.now() - ageMinutes * 60_000);
	utimesSync(target, modified, modified);
	return target;
}

test("recovery refuses to delete outside /tmp", () => {
	assert.throws(
		() => recoverTempSpace({ directory: "/dev/null", requiredBytes: 0 }),
		/only operates under \/tmp/,
	);
});

test("disposable Pi files are evicted before unrelated older entries", () => {
	const root = fixture();
	const unrelatedOld = file(root, "research-old", 30);
	const piOutput = file(root, "pi-output-test.log", 1);
	const unrelatedNew = file(root, "research-new", 0);

	const result = recoverTempSpace({ directory: root, requiredBytes: 0 });

	assert.equal(result.enough, true);
	assert.equal(result.escalated, false);
	assert.equal(existsSync(piOutput), false);
	assert.equal(existsSync(unrelatedOld), true);
	assert.equal(existsSync(unrelatedNew), true);
});

test("recovery escalates oldest-first when Pi artifacts are insufficient", () => {
	const root = fixture();
	const piOutput = file(root, "pi-bash-test.log", 1, 4 * 1024);
	const unrelatedOld = file(root, "research-old", 30);
	const unrelatedNew = file(root, "research-new", 0);

	const result = recoverTempSpace({ directory: root, requiredBytes: 0 });

	assert.equal(result.enough, true);
	assert.equal(result.escalated, true);
	assert.equal(existsSync(piOutput), false);
	assert.equal(existsSync(unrelatedOld), false);
	assert.equal(existsSync(unrelatedNew), true);
});

test("recovery reports insufficient space instead of deleting a protected entry", () => {
	const root = fixture();
	const protectedFile = file(root, "active-research", 30);

	const result = recoverTempSpace({
		directory: root,
		requiredBytes: 0,
		protectedPaths: [protectedFile],
	});

	assert.equal(result.enough, false);
	assert.equal(result.deletedCount, 0);
	assert.equal(existsSync(protectedFile), true);
});

test("live paths are protected while enough space is removed for new data", () => {
	const root = fixture();
	const protectedOld = file(root, "active-research", 30);
	const removableOld = file(root, "inactive-research", 20);
	const removableNew = file(root, "new-research", 0);

	const result = recoverTempSpace({
		directory: root,
		requiredBytes: 100 * 1024,
		protectedPaths: [protectedOld],
	});

	assert.equal(result.enough, true);
	assert.ok(result.targetBytes >= result.beforeBytes * 0.3 + 100 * 1024);
	assert.ok(result.afterBytes + 100 * 1024 <= result.beforeBytes * 0.7);
	assert.equal(existsSync(protectedOld), true);
	assert.equal(existsSync(removableOld), false);
	assert.equal(existsSync(removableNew), false);
});
