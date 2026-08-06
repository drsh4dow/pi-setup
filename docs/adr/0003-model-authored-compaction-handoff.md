# Compaction handoffs are written by the acting model, not a summarizer

The previous compaction extension generated its summary with an out-of-band LLM pass over the transcript, structured as a "Resume Contract" of terms (mutation lease, liveness gate, economics interval) defined nowhere the resumed model could see. A third-party reader cannot recover intent that lives in the actor's reasoning, and the contract's "reload the active controller skill" field made a resumed model execute a skill the session was editing. We decided that crossing the compaction boundary injects one handoff turn in which the acting model — with full live context — writes its own handoff (objective, per-artifact stance labels, state, next action, continuation choice), and compaction embeds that text verbatim with no LLM call. The summarizer survives only as a fallback for manual compaction, overflow recovery, and malformed replies, prompted to produce the same plain-language structure.

## Consequences

The common path trades the summarizer's full-prefix call for one prefix-cached handoff turn, roughly cost-neutral. The model now chooses whether a continuation turn fires at all: `continue` resumes autonomously, `done` and `ask-user` leave the session waiting for the user. A lazy or missing handoff degrades to the summarizer, never blocks compaction.
