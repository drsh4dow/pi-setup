// Folders under evals/<eval>/ that hold deliberately defective or partial code for eval graders
// to read, such as fixture repositories, change overlays, and planted-defect answer keys. No gate
// judges them: fmt and lint ignore them in vite.config.ts, and verify-docs skips them. Add a new
// kind of fixture folder here and every gate skips it.
export const EVAL_FIXTURE_FOLDERS = ["fixtures", "changes", "defects"] as const;

const EVAL_FIXTURE_PATH = new RegExp(`^evals/[^/]+/(?:${EVAL_FIXTURE_FOLDERS.join("|")})/`);

export function isEvalFixturePath(path: string): boolean {
  return EVAL_FIXTURE_PATH.test(path);
}
