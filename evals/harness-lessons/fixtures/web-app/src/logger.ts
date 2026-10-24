// The one sanctioned way for application code to write output: every line gets a timestamp
// and a level, so the log collector can parse it.
export type Level = "info" | "warn" | "error";

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), level, message, ...fields }));
}
