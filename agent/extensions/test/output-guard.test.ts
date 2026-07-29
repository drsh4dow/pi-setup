import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

function runOutputGuard(failures: number, emitError = false) {
	const outputGuard = pathToFileURL(
		resolve(
			process.env.PI_OUTPUT_GUARD_PATH ??
				"node_modules/@earendil-works/pi-coding-agent/dist/core/output-guard.js",
		),
	).href;
	const script = `
    import {
      restoreStdout,
      takeOverStdout,
      waitForRawStdoutBackpressure,
      writeRawStdout,
    } from ${JSON.stringify(outputGuard)};

    const originalWrite = process.stdout.write;
    let attempts = 0;
    process.stdout.write = ((chunk, encodingOrCallback, callback) => {
      const done = typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : callback;
      attempts++;
      queueMicrotask(() => {
        if (attempts <= ${failures}) {
          const error = new Error("quota fixture");
          error.code = "Unknown system error -122";
          error.errno = -122;
          done?.(error);
        } else {
          done?.();
        }
      });
      return attempts > ${failures};
    });

    writeRawStdout("frame");
    await waitForRawStdoutBackpressure();
    process.stdout.write = originalWrite;

    if (${emitError}) {
      takeOverStdout();
      const emitted = new Error("quota fixture");
      emitted.code = "Unknown system error -122";
      emitted.errno = -122;
      process.stdout.emit("error", emitted);
      restoreStdout();
    }
    process.stdout.write("attempts=" + attempts + "\\n");
  `;
	return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: process.cwd(),
		encoding: "utf8",
		timeout: 5_000,
	});
}

test("transient stdout quota errors do not terminate the Pi process", () => {
	const result = runOutputGuard(2, true);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "attempts=3\n");
});

test("persistent stdout pressure reports the dropped frame and recovery", () => {
	const result = runOutputGuard(1_000);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "attempts=100\n");
	assert.equal(
		result.stderr,
		"[pi] stdout remained unavailable after 100 attempts; one display frame was dropped. Restart Pi if the interface appears incomplete.\n",
	);
});
