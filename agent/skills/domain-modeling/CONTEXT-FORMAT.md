# Glossary format

Follow the repository's existing glossary structure. For a new authorized glossary, start small:

```md
# {Context name}

{What this context covers.}

## Language

**Order**: A customer's request to purchase a set of items.
_Avoid_: Purchase request
```

Define terms whose domain meaning matters to the project. Keep definitions brief and precise. List avoided synonyms only when they prevent actual ambiguity; general programming concepts do not need glossary entries.

Group terms when useful, without creating sections for every distinction. Keep implementation decisions in their appropriate documents rather than expanding the glossary into a specification.

For multiple contexts, follow the root `CONTEXT-MAP.md` to the relevant glossary. Create a map only when the project actually has distinct contexts that need navigation. Ask about context ownership only when it cannot be inferred and changes the result.
