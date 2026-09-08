#!/bin/zsh
# Page-count scaling with the content-store confound REMOVED: every cold stage
# gets its own fresh content store, so we measure how the pipeline scales with
# PAGES, not with the size of the user's lifetime cache.
# Warm stage reuses the cold stage's store AND project (incremental re-crawl).
# Usage: stages.sh <N> [N...]
set -u
HERE=${0:A:h}
# One origin for the whole sweep. Without this each stage gets a fresh
# OS-assigned port and the warm stage crawls a different site, so it re-fetches
# everything and reports no reuse — see run-stage.sh's BENCH_PORT comment.
export BENCH_PORT=${BENCH_PORT:-8920}

for N in "$@"; do
  S=st$N$(date +%H%M%S)
  ST=$HERE/stores/st$N.db
  rm -f $ST $ST-shm $ST-wal
  rm -rf ~/.squirrel/projects/bench-st$N

  echo "### $(date +%T) COLD  N=$N (fresh content store)"
  BENCH_PROJECT=bench-st$N BENCH_SALT=$S BENCH_REQ_LOG=1 BENCH_KILL_SEC=5400 \
    BENCH_CONTENT_STORE=$ST BENCH_KILL_MB=${BENCH_KILL_MB:-4096} \
    $HERE/run-stage.sh p${N}cold $N $N

  echo "### $(date +%T) WARM  N=$N (same store, same project)"
  BENCH_PROJECT=bench-st$N BENCH_SALT=$S BENCH_REQ_LOG=1 BENCH_KILL_SEC=5400 \
    BENCH_CONTENT_STORE=$ST BENCH_KILL_MB=${BENCH_KILL_MB:-4096} \
    $HERE/run-stage.sh p${N}warm $N $N

  echo "### $(date +%T) store size: $(ls -l $ST 2>/dev/null | awk '{print $5}') bytes"
done
echo "### ALL DONE $(date +%T)"
