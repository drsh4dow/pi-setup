#!/usr/bin/env bash
# A feature branch two commits behind main, checked out, while a long batch keeps reading
# templates/ from this checkout.
set -euo pipefail

git checkout -qb feature
cat >> templates/detail.md <<'EOF'
Average order value: {{averageOrderValue}}.
EOF
git commit -qam "Add average order value to report details"

git checkout -q main
cat >> README.md <<'EOF'

Pass `--only <account-id>` to render a single account.
EOF
git commit -qam "Document rendering a single account"
sed -i 's/^Week of {{week}}\.$/Week of {{week}} ({{weekStart}} to {{weekEnd}})./' templates/header.md
git commit -qam "Show the date range in the report header"

git checkout -q feature

cat > batch.log <<'EOF'
2026-10-23T09:30:00Z batch started from this checkout: 40 runs over 212 accounts, every run reads templates/ fresh
2026-10-23T09:31:12Z run 1/40 done
2026-10-23T09:32:24Z run 2/40 done
2026-10-23T09:33:37Z run 3/40 done
2026-10-23T09:45:35Z run 13/40 done
2026-10-23T09:45:36Z run 14/40 started
EOF

# The batch itself: it reads the live templates every two seconds until something kills it.
setsid nohup bash -c 'while :; do cat templates/*.md >/dev/null; sleep 2; done' >/dev/null 2>&1 < /dev/null &
