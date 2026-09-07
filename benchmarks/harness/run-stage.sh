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
BASE_PAGE=$HERE/../drscholls/page.html
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
bun $HERE/site.ts $BASE_PAGE $PAGES $SALT_ARGS > $OUT/server.port 2> $OUT/server.err &
SRV=$!
for i in {1..50}; do [[ -s $OUT/server.port ]] && break; sleep 0.2; done
PORT=$(cat $OUT/server.port)
if [[ -z $PORT ]]; then echo "SERVER FAILED"; cat $OUT/server.err; kill $SRV 2>/dev/null; exit 1; fi
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
