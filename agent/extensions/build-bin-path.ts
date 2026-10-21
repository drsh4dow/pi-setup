const { delimiter } = process.getBuiltinModule("node:path");

const { fileURLToPath } = process.getBuiltinModule("node:url");

const processEnvironment = process.getBuiltinModule("node:process").env;

const buildBin = fileURLToPath(new URL("../../.build/bin", import.meta.url));

// Pi's bash tool reads process.env for every command, so this reaches commands run after load.
export default function buildBinPath(): void {
  const entries = processEnvironment.PATH?.split(delimiter) ?? [];

  if (entries.includes(buildBin)) return;

  processEnvironment.PATH = [buildBin, ...entries].filter(Boolean).join(delimiter);
}
