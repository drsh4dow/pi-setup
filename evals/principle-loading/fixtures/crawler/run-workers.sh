#!/usr/bin/env bash
set -euo pipefail
for shard in 0 1 2 3; do
  node worker.js "$shard" 4 &
done
wait
