# Interactive logic prototype

Use a single HTML file when a person needs to press buttons and inspect state transitions. For a question that execution alone can answer, prefer a smaller runnable example.

## Build

1. State the question visibly so the user can judge whether the demo answers it.
2. Keep the model separate from page rendering. Choose the simplest structure that fits: functions, a reducer, or a state machine when transitions require one.
3. Render relevant state with domain labels and provide controls for the actions being explored.
4. Add a reset and guided scenarios only where they help reproduce the uncertain cases.

For a shareable HTML demo, inline its CSS and JavaScript so it opens without a build or server. Keep layout restrained; polish only what helps someone understand the model.

## Deliver

Exercise the relevant scenarios, then provide the file and findings. Explain any assumptions the prototype leaves unresolved. Follow [SKILL.md](SKILL.md) for scope and cleanup; answering the question does not automatically authorize production integration or archival commits.
