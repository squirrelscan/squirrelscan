#!/bin/zsh
# One benchmark stage: serve an N-page synthetic estate, run `squirrel audit`
# against it under an external RSS sampler + in-process heap probe, record
# everything under results/<label>/.
#
# Usage: run-stage.sh <label> <pages> <maxPages> [extra squirrel args...]
#   label     directory name for results
#   pages     size of the synthetic site to serve
#   maxPages  --max-pages passed to the CLI
#
# Env:
#   BENCH_PROJECT   squirrel project name (controls which project.db is reused;
#                   same name across two stages = warm/incremental run)
#   BENCH_KILL_MB   kill the audit above this RSS (default 4096)
#   BENCH_KILL_SEC  kill the audit after this many seconds (default 3600)
#   BENCH_RULE_PROFILE=1 to enable per-rule timing on stderr
set -u

HERE=${0:A:h}
LANE=${BENCH_REPO:-$(git -C "$HERE" rev-parse --show-toplevel)/..}
BASE_PAGE=${BENCH_BASE_PAGE:?set BENCH_BASE_PAGE to a large script-heavy HTML file to serve as the product template}
LABEL=$1; PAGES=$2; MAXPAGES=$3; shift 3
OUT=$HERE/results/$LABEL
KILL_MB=${BENCH_KILL_MB:-4096}
KILL_SEC=${BENCH_KILL_SEC:-3600}
PROJECT=${BENCH_PROJECT:-bench$PAGES}

rm -rf $OUT; mkdir -p $OUT
echo "== stage $LABEL: serving $PAGES pages, auditing max $MAXPAGES, project=$PROJECT"

# ── serve ───────────────────────────────────────────────────────
[[ ${BENCH_REQ_LOG:-0} == 1 ]] && export BENCH_REQ_LOG=$OUT/requests.log
SALT=${BENCH_SALT:-}
# zsh does NOT word-split an unquoted parameter expansion, so ${SALT:+--salt $SALT}
# would arrive as ONE argv entry and indexOf("--salt") would miss it. Build an array.
SALT_ARGS=()
[[ -n $SALT ]] && SALT_ARGS=(--salt $SALT)
# BENCH_PORT pins the origin across the stages of one pair. Without it every
# stage gets a fresh OS-assigned port, so the "warm" stage crawls a DIFFERENT
# origin (http://localhost:<new port>/p/1) and the incremental path has nothing
# stored under those URLs to revalidate — it re-fetches all N pages and reports
# no cache hits at all. A warm row measured that way is a second cold crawl.
PORT_ARGS=()
if [[ -n ${BENCH_PORT:-} ]]; then
  # site.ts does Number(arg), which turns "", whitespace and "not-a-port" into 0
  # or NaN and silently falls back to an OS-assigned port — the exact failure
  # BENCH_PORT exists to prevent, and one that only shows up later as a warm
  # stage that reused nothing. Refuse instead.
  if [[ ! $BENCH_PORT =~ '^[0-9]+$' ]] || (( BENCH_PORT < 1 || BENCH_PORT > 65535 )); then
    echo "BENCH_PORT must be an integer 1-65535, got '$BENCH_PORT'"; exit 1
  fi
  PORT_ARGS=(--port $BENCH_PORT)
fi
bun $HERE/site.ts $BASE_PAGE $PAGES $SALT_ARGS $PORT_ARGS > $OUT/server.port 2> $OUT/server.err &
SRV=$!
for i in {1..50}; do [[ -s $OUT/server.port ]] && break; sleep 0.2; done
PORT=$(cat $OUT/server.port)
if [[ -z $PORT ]]; then echo "SERVER FAILED"; cat $OUT/server.err; kill $SRV 2>/dev/null; exit 1; fi
# The port the server actually bound, not the one we asked for: a mismatch means
# the pair is measuring two different origins and the warm row would be a lie.
if [[ -n ${BENCH_PORT:-} && $PORT != $BENCH_PORT ]]; then
  echo "server bound $PORT, not the requested BENCH_PORT=$BENCH_PORT"; kill $SRV 2>/dev/null; exit 1
fi
echo "   server pid=$SRV port=$PORT"
URL="http://localhost:$PORT"

# sanity: seed + one heavy page reachable
curl -sS -o /dev/null -w "   seed %{http_code} %{size_download}B\n" $URL/ || true
curl -sS -o /dev/null -w "   /p/0 %{http_code} %{size_download}B\n" $URL/p/0 || true

# ── audit under probes ──────────────────────────────────────────
# Point the GLOBAL content store somewhere private when asked, so a stage can be
# measured against an empty store instead of the user's ~1 GB lifetime cache.
[[ -n ${BENCH_CONTENT_STORE:-} ]] && export SQUIRREL_CONTENT_STORE_PATH=$BENCH_CONTENT_STORE
export BENCH_MEM_LOG=$OUT/mem.jsonl
export BENCH_MEM_MS=${BENCH_MEM_MS:-500}
[[ ${BENCH_RULE_PROFILE:-0} == 1 ]] && export SQUIRREL_RULE_PROFILE=1

cd $LANE
# fresh trace log per stage so phase spans are unambiguous
mkdir -p ~/.squirrel/logs && : > ~/.squirrel/logs/trace.log
STARTED=$(date +%s)
/usr/bin/time -l bun --preload $HERE/mem-probe.ts \
  repo-public/apps/cli/src/cli.ts audit $URL \
  --coverage full --max-pages $MAXPAGES --http --offline \
  --project-name $PROJECT --trace \
  -f json -o $OUT/report.json "$@" \
  > $OUT/audit.out 2> $OUT/audit.time &
AUDIT=$!

# external RSS sampler + guard rails (samples the whole process tree)
bun $HERE/rss-sampler.ts $AUDIT $OUT/rss.log $KILL_MB $KILL_SEC $OUT/guard.log &
SAMPLER=$!

wait $AUDIT; RC=$?
kill $SAMPLER 2>/dev/null; wait $SAMPLER 2>/dev/null
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null

cp ~/.squirrel/logs/trace.log $OUT/trace.log 2>/dev/null
PDB=~/.squirrel/projects/$(echo $PROJECT | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9]\{1,\}/-/g')/project.db
[[ -f $PDB ]] && ls -l $PDB | awk '{print $5}' > $OUT/projectdb.bytes

echo "   exit rc=$RC after $(( $(date +%s) - STARTED ))s"
echo $RC > $OUT/rc
echo $PORT > $OUT/port
echo $PROJECT > $OUT/project
[[ -f $OUT/guard.log ]] && cat $OUT/guard.log
exit 0
