# Issue tracker: GitHub

Issues and specs for this repository live as GitHub issues. Use the `gh` CLI for every operation. It infers the repository from `git remote -v` inside a clone.

## Operations

- **Publish**: `gh issue create --title "..." --body-file -` with the body on a heredoc.
- **Fetch**: `gh issue view <number> --json number,title,body,state,author,createdAt,updatedAt,labels,comments,parent,subIssues,blockedBy,blocking,closedByPullRequestsReferences`.
- **Search**: `gh issue list --state all --search "<words>" --json number,title,state,labels`.
- **Edit**: `gh issue edit <number> --title "..." --body-file -` with the body on a heredoc.
- **Comment**: `gh issue comment <number> --body-file -`.
- **Nest under a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards. Without sub-issues, start the child body with `Part of #<parent>`.
- **Block**: `gh api --method POST repos/<owner>/<repo>/issues/<blocked>/dependencies/blocked_by -F issue_id=<blocker-id>`, where `<blocker-id>` is the blocker's database id from `gh api repos/<owner>/<repo>/issues/<number> --jq .id`, not its number. Where dependencies are unavailable, start the blocked issue's body with `Blocked by: #<n>, #<n>`.
- **Close**: `gh issue close <number> --comment "..."`. For a duplicate, add `--duplicate-of <canonical>`.

GitHub shares one number space between issues and pull requests, so a bare `#42` can be either. Resolve it with `gh pr view 42`, then `gh issue view 42`.
