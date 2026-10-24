import type { Grader } from "./record.ts";
import type { ScenarioId } from "./scenarios.ts";
import {
  adaptOutsideSkill,
  boundedRecheck,
  crossProject,
  dependencyByPath,
} from "./grade-artifacts.ts";
import { catchup, catchupVideo } from "./grade-catchup.ts";
import { newGate, vacuousPass } from "./grade-checks.ts";
import {
  cosmeticWake,
  handEditsUseEdit,
  restateSharpened,
  skillTuningMethod,
} from "./grade-conduct.ts";
import { concurrentMain, liveReaderRebase, liveRunVerify } from "./grade-live-checkout.ts";

export const graders: Record<ScenarioId, Grader> = {
  "live-reader-rebase": liveReaderRebase,
  "live-run-verify": liveRunVerify,
  "concurrent-main": concurrentMain,
  "vacuous-pass": vacuousPass,
  "new-gate": newGate,
  "skill-tuning-method": skillTuningMethod,
  "cross-project": crossProject,
  "adapt-outside-skill": adaptOutsideSkill,
  "bounded-recheck": boundedRecheck,
  "dependency-by-path": dependencyByPath,
  "cosmetic-wake": cosmeticWake,
  "restate-sharpened": restateSharpened,
  "hand-edits-use-edit": handEditsUseEdit,
  catchup,
  "catchup-video": catchupVideo,
};
