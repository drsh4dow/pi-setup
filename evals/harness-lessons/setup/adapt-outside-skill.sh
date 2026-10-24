#!/usr/bin/env bash
# A skill someone just downloaded, not yet committed.
set -euo pipefail

mkdir -p incoming/changelog-skill
cp "$(dirname "$0")/../fixtures/changelog-skill/SKILL.md" incoming/changelog-skill/SKILL.md
