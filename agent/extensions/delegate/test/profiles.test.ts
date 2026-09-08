import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	readDelegateModelSetting,
	readProjectDelegateModelSetting,
} from "../runtime.ts";

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } =
	process.getBuiltinModule("fs");
const { join } = process.getBuiltinModule("path");

test("selects independent model and thinking profiles with project precedence", (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-delegate-profiles-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const settingsPath = join(cwd, "settings.json");
	const profiles = {
		fast: { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
		thorough: { model: "openai-codex/gpt-6-astra", thinking: "low" },
	};
	writeFileSync(settingsPath, JSON.stringify({ delegate: profiles }));
	assert.deepEqual(readDelegateModelSetting(settingsPath), profiles.fast);
	assert.deepEqual(
		readDelegateModelSetting(settingsPath, "thorough"),
		profiles.thorough,
	);
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(
		join(cwd, ".pi", "delegate.json"),
		JSON.stringify({ fast: { model: "test/project" } }),
	);
	assert.deepEqual(readProjectDelegateModelSetting(cwd, { settingsPath }), {
		model: "test/project",
		thinking: "high",
	});
	assert.deepEqual(
		readProjectDelegateModelSetting(cwd, { settingsPath, effort: "thorough" }),
		profiles.thorough,
	);
	for (const profile of [
		null,
		[],
		"invalid",
		{ thinking: "invalid" },
		{ model: null },
		{ thinking: null },
	]) {
		writeFileSync(
			settingsPath,
			JSON.stringify({ delegate: { fast: profile } }),
		);
		assert.ok(readDelegateModelSetting(settingsPath).problem);
	}
});
