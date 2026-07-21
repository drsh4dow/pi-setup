import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve pi's agent config directory.
 *
 * Honors PI_CODING_AGENT_DIR (the same override pi itself respects), falling
 * back to the default `~/.pi/agent`. All credential and log artifacts live
 * under this directory so the extension stays consistent with pi's layout.
 */
export function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
