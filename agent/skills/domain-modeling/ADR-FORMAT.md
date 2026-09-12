# ADR format

For an authorized decision that meets the criteria in [SKILL.md](SKILL.md), follow the repository's existing ADR location and numbering. Otherwise use `docs/adr/` and the next available `0001-slug.md` number. Create the directory only when needed.

```md
# {Decision}

{The context, what was decided, and why.}
```

A paragraph is often sufficient. Add sections only for information a future reader needs:

- **Status:** distinguish proposed, accepted, deprecated, or superseded decisions when relevant.
- **Alternatives:** preserve rejected options when the reason for rejection is consequential or surprising.
- **Consequences:** record non-obvious effects and constraints.

State actual tradeoffs rather than filling a template. Keep unresolved proposals distinct from accepted decisions.
