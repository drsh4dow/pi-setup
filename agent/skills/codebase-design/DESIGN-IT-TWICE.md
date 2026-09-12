# Compare interface designs

Use this when competing interface shapes could materially change the outcome.

1. Establish required behavior, existing callers, dependency constraints, and the source of current friction.
2. Sketch alternatives that differ in responsibility or interface shape. Show enough usage to expose what callers must know.
3. Compare complexity hidden, knowledge concentrated, migration cost, and the common caller's experience.
4. Recommend the simplest design supported by the evidence. Implement when implementation is authorized; otherwise deliver the comparison.

Use prose or small code sketches first. Build a prototype only when running it would resolve uncertainty. There is no required number of alternatives or approval checkpoint for routine design decisions.
