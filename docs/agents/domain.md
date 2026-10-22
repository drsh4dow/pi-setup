# Domain docs

How agents read and grow this repository's domain documentation.

## Layout

Single-context: one `GLOSSARY.md` and one `docs/adr/` at the repository root.

## Before exploring

Read the glossary for the area you work in, and the ADRs that touch it. A missing file means nothing is recorded yet. The **domain-modeling** skill creates each file when its first term or decision is settled.

## Use the glossary's terms

Name a domain concept by its glossary term in issue titles, proposals, test names, and code. When the concept you need has no term, either you are inventing language the project does not use, or there is a gap to settle with the **domain-modeling** skill.

## Flag ADR conflicts

When your output contradicts an ADR, say so explicitly rather than overriding it silently: "Contradicts ADR-0007 (event-sourced orders), and worth reopening because ..."
