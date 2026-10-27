# Issue tracker: GitLab

Issues and specs for this repository live as GitLab issues. Use the [`glab`](https://gitlab.com/gitlab-org/cli) CLI for every operation. It infers the project from `git remote -v` inside a clone.

## Operations

- **Publish**: `glab issue create --title "..." --description-file -` with the description on a heredoc.
- **Fetch**: `glab issue view <number> --comments`, or `-F json` for machine-readable output.
- **Search**: `glab issue list --all --search "<words>" -O json`.
- **Edit**: `glab issue update <number> --title "..." --description-file -` with the description on a heredoc.
- **Comment**: `glab issue note <number> --message "..."`. GitLab calls comments notes.
- **Nest under a parent**: start the child description with `Part of #<parent>`. On tiers with epics or tasks, the user may name those instead.
- **Block**: create the blocked issue with `--linked-issues <blocker> --link-type is_blocked_by`, or post the quick action `/blocked_by #<blocker>` as a note with `glab issue note <blocked> --message "/blocked_by #<blocker>"`. Native blocking links need Premium or Ultimate. Elsewhere, start the blocked description with `Blocked by: #<n>, #<n>`.
- **Close**: `glab issue close <number>`. It takes no comment, so post the explanation as a note first. For a duplicate, post the quick action `/duplicate #<canonical>` as a note, which closes the issue.

GitLab numbers issues and merge requests separately, so `#42` is an issue and `!42` a merge request.
