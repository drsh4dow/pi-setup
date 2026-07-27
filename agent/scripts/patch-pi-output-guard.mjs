import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RETRY_DECLARATION = "const RAW_STDOUT_RETRY_DELAY_MS = 10;";
const RETRY_MARKER = "const RAW_STDOUT_MAX_RETRIES = 100;";
const QUOTA_MARKER = "const RAW_STDOUT_QUOTA_ERRNO = -122;";
const FAILURE_NOTICE_MARKER =
  'const RAW_STDOUT_FAILURE_NOTICE = "[pi] stdout remained unavailable after 100 attempts; one display frame was dropped. Restart Pi if the interface appears incomplete.\\n";';
const FAILURE_STATE_MARKER = "let rawStdoutFailureReported = false;";
const SUCCESS_RETURN = "            });\n            return;";
const REPORTED_SUCCESS_RETURN =
  "            });\n            rawStdoutFailureReported = false;\n            return;";
const DROP_BLOCK =
  "if (attempts === RAW_STDOUT_MAX_RETRIES) {\n                return;\n            }";
const REPORTED_DROP_BLOCK =
  "if (attempts === RAW_STDOUT_MAX_RETRIES) {\n                if (!rawStdoutFailureReported) {\n                    rawStdoutFailureReported = true;\n                    try {\n                        process.stderr.write(RAW_STDOUT_FAILURE_NOTICE);\n                    }\n                    catch {\n                        // The original stdout failure remains the actionable evidence.\n                    }\n                }\n                return;\n            }";
const RETRY_BLOCK =
  'const code = writeError.code;\n            if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {\n                throw writeError;\n            }\n            await new Promise((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));';
const RETRY_BLOCK_V1 =
  'const code = writeError.code;\n            if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK" && code !== "EDQUOT") {';
const RETRY_BLOCK_V2 =
  'const code = writeError.code;\n            const errno = writeError.errno;\n            if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK" && code !== "EDQUOT" && errno !== RAW_STDOUT_QUOTA_ERRNO) {';
const PATCHED_RETRY_BLOCK =
  'const code = writeError.code;\n            const errno = writeError.errno;\n            if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK" && code !== "EDQUOT" && errno !== RAW_STDOUT_QUOTA_ERRNO) {\n                throw writeError;\n            }\n            attempts++;\n            if (attempts === RAW_STDOUT_MAX_RETRIES) {\n                return;\n            }\n            await new Promise((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));';

function replaceOnce(source, oldText, newText, path) {
  const start = source.indexOf(oldText);
  if (start === -1 || source.indexOf(oldText, start + oldText.length) !== -1)
    throw new Error(`Unsupported Pi output guard at ${path}`);
  return `${source.slice(0, start)}${newText}${source.slice(start + oldText.length)}`;
}

function addFailureReporting(source, path) {
  source = replaceOnce(
    source,
    QUOTA_MARKER,
    `${QUOTA_MARKER}\n${FAILURE_NOTICE_MARKER}`,
    path,
  );
  source = replaceOnce(
    source,
    "let rawStdoutWriteTail = Promise.resolve();",
    `${FAILURE_STATE_MARKER}\nlet rawStdoutWriteTail = Promise.resolve();`,
    path,
  );
  source = replaceOnce(source, SUCCESS_RETURN, REPORTED_SUCCESS_RETURN, path);
  return replaceOnce(source, DROP_BLOCK, REPORTED_DROP_BLOCK, path);
}

function replaceFile(path, source) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, source);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function patchOutputGuard(path) {
  let source = readFileSync(path, "utf8");
  if (source.includes(FAILURE_NOTICE_MARKER)) return false;
  if (source.includes(QUOTA_MARKER)) {
    source = addFailureReporting(source, path);
    replaceFile(path, source);
    return true;
  }
  if (source.includes(RETRY_MARKER)) {
    source = replaceOnce(
      source,
      RETRY_MARKER,
      `${RETRY_MARKER}\n${QUOTA_MARKER}`,
      path,
    );
    source = replaceOnce(source, RETRY_BLOCK_V1, RETRY_BLOCK_V2, path);
    source = addFailureReporting(source, path);
    replaceFile(path, source);
    return true;
  }
  source = replaceOnce(
    source,
    RETRY_DECLARATION,
    `${RETRY_DECLARATION}\n${RETRY_MARKER}\n${QUOTA_MARKER}`,
    path,
  );
  source = replaceOnce(
    source,
    "async function writeRawStdoutChunk(text) {\n    while (true) {",
    "async function writeRawStdoutChunk(text) {\n    let attempts = 0;\n    while (true) {",
    path,
  );
  source = replaceOnce(source, RETRY_BLOCK, PATCHED_RETRY_BLOCK, path);
  source = replaceOnce(
    source,
    "    const originalStdoutWrite = process.stdout.write;\n    process.stdout.write =",
    '    const originalStdoutWrite = process.stdout.write;\n    const onRawStdoutError = () => {};\n    process.stdout.on("error", onRawStdoutError);\n    process.stdout.write =',
    path,
  );
  source = replaceOnce(
    source,
    "        originalStdoutWrite,\n    };",
    "        originalStdoutWrite,\n        onRawStdoutError,\n    };",
    path,
  );
  source = replaceOnce(
    source,
    "    process.stdout.write = stdoutTakeoverState.originalStdoutWrite;\n    stdoutTakeoverState = undefined;",
    '    process.stdout.write = stdoutTakeoverState.originalStdoutWrite;\n    process.stdout.off("error", stdoutTakeoverState.onRawStdoutError);\n    stdoutTakeoverState = undefined;',
    path,
  );
  source = addFailureReporting(source, path);

  replaceFile(path, source);
  return true;
}

function installedOutputGuards() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const local = join(
    root,
    "node_modules/@earendil-works/pi-coding-agent/dist/core/output-guard.js",
  );
  const paths = new Set([local]);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const executable = join(
      directory,
      process.platform === "win32" ? "pi.exe" : "pi",
    );
    if (!existsSync(executable)) continue;
    const target = join(
      dirname(realpathSync(executable)),
      "core/output-guard.js",
    );
    if (target === local) continue;
    if (existsSync(target)) paths.add(target);
    break;
  }
  return [...paths].filter(existsSync);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const paths = installedOutputGuards();
  if (paths.length === 0)
    throw new Error("No Pi output guard installation found.");
  for (const path of paths)
    console.log(`${patchOutputGuard(path) ? "Patched" : "Verified"} ${path}`);
}
