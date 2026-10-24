# Issue tracker: tracker

Tickets for this repository live in the team's tracker, reached through the `tracker` CLI on `PATH`. Ticket keys look like `TAL-12`. States are `Todo`, `In Progress`, and `Done`. The tracker is connected to GitHub.

## Operations

- **Fetch**: `tracker view <key>` prints the ticket as JSON: title, body, state, parent, children, blocked-by, comments.
- **List**: `tracker list [--parent <key>] [--state <state>]`.
- **Comment**: `tracker comment <key> --body-file -`, with the body on stdin.
- **Set state**: `tracker state <key> "<state>"`.
- **Close**: `tracker close <key>` sets `Done`.
