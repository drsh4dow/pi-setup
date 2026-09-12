---
name: to-spec
description: Synthesize an agreed feature into a concise spec and publish it when requested.
disable-model-invocation: true
---

# To spec

Synthesize the conversation and relevant repository evidence. Preserve established decisions without reopening routine implementation choices or requiring test-seam approval.

Use the project's domain terms and respect relevant ADRs. Inspect only the code needed to establish the current state or resolve a material gap.

## Spec

Include the problem, proposed outcome, acceptance criteria, and consequential decisions. Add scope exclusions, technical pointers, or unresolved questions only when they help the implementer. Capture decision-rich prototype snippets when they communicate a contract better than prose.

Use as few user stories or sections as the feature needs. Record testing decisions only for credible failures worth protecting; omit generic testing philosophy and obvious behavior matrices.

Distinguish agreed requirements from assumptions. If a material decision remains open, record it and ask a focused question rather than inventing certainty.

## Deliver

Follow the requested destination. When publication is included, read the repository's tracker and label instructions and [writing-good-tickets](../writing-good-tickets/SKILL.md), then publish. If the tracker cannot be established, finish the draft before asking where to publish it.

Apply `ready-for-agent` only when the spec is sufficiently resolved for implementation and repository policy uses that label. A request for a draft ends with the draft.
