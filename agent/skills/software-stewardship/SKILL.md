---
name: software-stewardship
description: Use for user-facing production software.
disable-model-invocation: false
user-invokable: false
---

Software deserves **stewardship** when people must live with its experience, failures, demands, growth, repairs, and words. This skill owns user-facing product obligations; implementation mechanics stay with their engineering skills.

## Stewardship tests

Apply every test the changed user-facing behavior touches. Criterion: each applicable test has observable evidence, each test marked inapplicable has been checked against the product contract and affected flows, and every unmet obligation is reported plainly.

- **Experience-first.** Name each consumer affected by the decision. This includes end users, API callers, and maintainers. Judge the change from their seat, not by implementation convenience. Prefer fewer complete paths over more rough ones, and remove features or controls that distract from the core workflow. Check feedback, transitions, layout, error states, and other details people encounter. Prototype uncertain experience decisions in a disposable form before production code makes them costly to reverse.

- **Dependable.** Name the operating conditions the affected flow promises, including plausible interruption and degraded-service cases. Under those conditions it preserves user work, contains partial effects, and offers a safe next action. Verify recovery through the public interface; implementation bounds belong to `bounded-code`.

- **Quiet.** Reserve modals, prompts, badges, notifications, tours, and repeated warnings for an action the user must take now or information whose delay could materially harm them. Use the least intrusive surface that still works. Non-urgent status stays passive, defaults remain unintrusive, and operator diagnostics stay in operator channels.

- **Finite.** Every added capability, control, asset, and dependency serves the stated user problem and core workflow. Overlapping paths retire. Supported scale, lifetime, platform, and connectivity limits are explicit wherever crossing one would otherwise fail mysteriously. Foundations may determine the order of work, but the intended experience determines what earns a place in the product.

- **Repairable.** A changed failure leaves maintainers enough evidence to find it and users a path to resume. Updates and migrations preserve work, data, settings, and compatibility; partial progress can safely resume or roll back. User intervention is reserved for consent, ambiguity, or irreversible effects.

- **Human-spoken.** Inventory changed prose that people are expected to read: interface copy, onboarding, notifications, emails, and public errors. Final production wording has a named human author or explicit human approval, evidenced by human-supplied copy, approval in the issue, pull request, or conversation, or recorded sign-off. Agent-written wording remains a marked draft until then; machine diagnostics stay visibly separate from the product's voice.

Stewardship passes when evidence covers every applicable normal, degraded, and recovery flow, consumer experience, attention demand, product limit, and prose approval.
