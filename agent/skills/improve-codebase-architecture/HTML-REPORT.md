# Architecture report

Write one HTML file to `$TMPDIR` or the OS temp directory with a unique descriptive name. Prefer inline CSS and static HTML/SVG so the report opens without setup. Use Mermaid when it makes a relationship substantially clearer; disclose any external asset dependency rather than calling the result offline self-contained.

## Structure

- **Header:** repository, scope, and the main recommendation.
- **Candidates:** affected files, observed friction, proposed simplification, maintenance benefit, migration cost, and strength (`Strong`, `Worth exploring`, or `Speculative`).
- **Visuals:** use a before/after view when it explains a structural change. Call graphs, sequences, or simple boxes are often sufficient.
- **Decision:** recommend the change that earns its cost, or state that no candidate does.

Name domain concepts consistently with the repository. Use familiar technical language; glossary terms clarify concepts without banning accurate words such as API, service, or boundary.

## Presentation

Use readable typography, generous spacing, restrained color, and a clear hierarchy. Keep each candidate together and make file paths easy to scan. Let prose explain tradeoffs that a diagram cannot show.

Diagrams need clear labels and relationships. Choose the visual that communicates the change; repeated structure is useful for comparison, and variety is not a goal. Ensure the report remains readable on a narrow viewport.

State uncertainty and source limitations. Avoid decorative badges, animations, or additional dependencies unless they help the reader decide.

Open the generated file and inspect the content and any diagrams before delivering it. This is a report check, not authorization for a broader product QA pass.
