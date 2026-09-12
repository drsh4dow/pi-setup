---
name: prototype
description: Build a small throwaway artifact to answer a question about logic, state, or UI interaction.
---

# Prototype

Identify the question and build the smallest artifact that answers it. Infer routine choices from the request and code; ask only when ambiguity would materially change the result.

- For logic or state, a small executable example may suffice. Use [LOGIC.md](LOGIC.md) when a person needs to interact with the model.
- For layout or interaction, use [UI.md](UI.md). Build alternative variants only when comparing them resolves uncertainty.

Keep the prototype clearly marked and isolated from production behavior. Reuse the project's run and routing conventions when appropriate. Prefer in-memory state; use scratch storage if persistence is the question. Avoid real mutations outside the authorized scope.

Skip tests, speculative abstractions, and polish unrelated to the question. Make the artifact runnable, expose relevant state, and exercise the path that answers the question.

Deliver the artifact, run instructions, findings, and unresolved decisions. Integrate it, create branches, or update issues only when those actions are requested or already part of the task. Preserve an artifact intended for the user to inspect; clean up owned processes and disposable state when no longer needed.
