#!/bin/sh
# Every example in docs/api.md evaluates to the value it shows.
set -eu
node scripts/check-docs.js
