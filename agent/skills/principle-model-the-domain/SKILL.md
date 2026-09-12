---
name: principle-model-the-domain
description: Simplify stateful logic when repeated branches, shape assumptions, or synchronized fields expose a missing domain model.
---

# Model the domain

Identify the states the system must represent, the states it must exclude, and the dominant access patterns. Choose a structure that removes real branches, invalid combinations, or coordination.

Useful choices include a discriminated union for lifecycle variants, a map for keyed access, or a module owning one body of domain knowledge. Keep each invariant and decision with its owner rather than repeating it across callers or processing phases.

Prefer the existing shape when it is clear and local. An additional conditional does not by itself justify a registry, reducer, state machine, or new abstraction. Strengthen the structure only where it simplifies the actual work.
