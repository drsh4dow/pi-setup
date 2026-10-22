# Issue tracker: faketrack

Issues and specs for this repository live in faketrack, the team's own tracker. Reach it through the `faketrack` CLI on `PATH`. Issue ids are plain numbers, written `#<id>`.

## Operations

- **Publish**: `faketrack create --title "..." --body-file - [--parent <id>]` with the body on a heredoc. It prints `created #<id>`.
- **Fetch**: `faketrack view <id>`.
- **Search**: `faketrack search <words>`.
- **Comment**: `faketrack comment <id> --body-file -`.
- **Nest under a parent**: pass `--parent <id>` to `faketrack create`.
- **Block**: `faketrack block <blocked-id> --by <blocker-id>`, once per edge.
- **Close**: `faketrack close <id>`.
