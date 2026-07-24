import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type DelegateDetails, DelegateParams, TOOL_NAME } from "./contract.ts";
import { renderDelegateCall, renderDelegateResult } from "./render.ts";
import { executeDelegate } from "./runtime.ts";

export {
  CHILD_EXTENSION_PATHS_ENV,
  type DelegateDetails,
  type DelegateEffort,
  type DelegateOutput,
  type DelegateThinking,
  type DelegateUsageStats,
} from "./contract.ts";
export { extractAssistantText, formatDelegateOutput } from "./output.ts";
export {
  childExtensionPaths,
  DELEGATION_TOOL_DENYLIST,
  readDelegateModelSetting,
  resolveDelegateModel,
  selectChildToolNames,
  thinkingForEffort,
} from "./runtime.ts";

export default function delegateExtension(pi: ExtensionAPI) {
  pi.registerTool<typeof DelegateParams, DelegateDetails>({
    name: TOOL_NAME,
    label: "Delegate",
    description:
      "Run a fresh child Pi agent as an isolated, bounded capability; the parent receives only the child’s final result and stays responsible for implementation, final validation, and the final answer by default. Consider delegate early when isolation is worth it for broad repo scanning or mapping, noisy/root-cause investigation, current docs/API/library research, plan critique, or debugging reconnaissance. Must use delegate when the user explicitly asks for child delegation or for an independent/fresh review/code review, because isolation is the point of that task. Do not use delegate for trivial answers, obvious typo/format/text-only edits, or tasks answerable with one or two cheap local tool calls. Do not treat ordinary non-trivial implementation as requiring delegation: implement and validate in the parent unless the user explicitly asks for child implementation or there is a clear isolation benefit. The child has normal Pi tools and may modify files, so write-capable delegation is exceptional and must be explicit in the task. Fast is the default for ordinary delegated work. Use thorough only for an explicit thorough effort-tier request, demonstrated reasoning-limited uncertainty after a fast result, or an error that would be costly and difficult to detect, correct, or rerun. Task category and requests for thorough work alone do not select the tier; missing information, unavailable access, tool failure, and task underspecification are blockers to address, not reasons to escalate.",
    promptSnippet:
      "Must use for explicitly requested independent/fresh review; otherwise use for isolated broad scans, docs/API research, noisy recon, plan critiques, and debugging reconnaissance. Parent owns implementation/final validation by default.",
    promptGuidelines: [
      "Consider delegate when isolation helps for broad repo scanning, repo mapping, noisy/root-cause investigation, current library/API research, plan critique, or debugging reconnaissance; if you use it, call it early before broad exploration when that context would otherwise pollute the parent.",
      "Must use delegate when the user explicitly asks for child delegation or for an independent/fresh review/code review; the child supplies the isolated second opinion, and the parent still owns the final answer.",
      "Do not use delegate for trivial fact lookups, obvious typo/format/text-only edits, or questions answerable with one or two cheap local tool calls; ordinary non-trivial implementation does not require delegation.",
      "Parent owns implementation, final validation, and the final answer by default; delegate write-capable child tasks only when explicitly requested or clearly exceptional, and state edit permission, constraints, expected output, and verification needs in the task.",
      "Fast is the default for ordinary delegated work, including scouting, docs/API lookup, review, critique, noisy investigation, and debugging. Use thorough only for an explicit thorough effort tier, demonstrated reasoning-limited uncertainty after fast, or an error that would be costly and difficult to detect, correct, or rerun; task category and natural-language requests for thorough work do not qualify by themselves.",
    ],
    parameters: DelegateParams,
    executionMode: "parallel",
    execute: executeDelegate,
    renderCall: renderDelegateCall,
    renderResult: renderDelegateResult,
  });
}
