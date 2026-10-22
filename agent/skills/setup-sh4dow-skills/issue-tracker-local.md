# Issue tracker: local Markdown

Issues and specs for this repository live as Markdown files in the `issues/` subfolder of the state folder that the system prompt defines, outside the repository.

## Layout

- One folder per feature: `<state folder>/issues/<feature-slug>/`.
- The spec is `<feature-slug>/spec.md`.
- Tickets are one file each at `<feature-slug>/tickets/<NN>-<slug>.md`, numbered from `01` in dependency order.
- A `Status:` line near the top of each file records `open`, and later `done`.
- A `Blocked by: NN, NN` line near the top lists the tickets that gate it. A ticket is unblocked when every file it lists is `done`.
- Comments append under a `## Comments` heading at the bottom of the file.

A ticket file opens with this header, then its body:

```markdown
# <NN>: <Ticket title>

Status: open
Blocked by: <NN, NN, or "None">
```

## Operations

- **Publish**: create the file, and its folder when needed. A ticket's body check runs on the body below the header.
- **Fetch**: read the file at the path or number the user passes.
- **Search**: `rg -il "<words>" <state folder>/issues/`.
- **Comment**: append under `## Comments`.
- **Nest under a parent**: tickets nest under their feature folder.
- **Block**: write the `Blocked by:` line.
- **Close**: set `Status: done`.
