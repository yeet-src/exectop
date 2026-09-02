#!/usr/bin/env bash
# End-to-end capture test: does the probe see everything, and only the truth?
#
# The unit tests in test/heuristics.test.mjs cover lib/model.js against recorded
# fixtures — pure aggregation, no kernel. That leaves the seam where the two
# real bugs lived: kernel → traced set → ring buffer → normalized record. This
# test covers that seam by running a workload whose exec count is known exactly
# and asserting the capture reproduces it.
#
#   test/capture.sh              # run it
#   test/capture.sh -v           # also print the full capture report
#
# Needs: make (already run), sudo for the probe, python3, curl, base64.
# Everything stays in a scratch dir under /tmp; the curl fetch uses file://,
# so nothing leaves the machine.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
VERBOSE=0
[[ "${1:-}" == "-v" ]] && VERBOSE=1

W=$(mktemp -d /tmp/exectop-capture-test.XXXXXX)
SECS=14
red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }

cleanup() { kill "${ROOT:-0}" 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT

for tool in python3 curl base64 chmod; do
  command -v "$tool" >/dev/null || { red "missing prerequisite: $tool"; exit 2; }
done
[[ -f bin/probe.bpf.o ]] || { red "bin/probe.bpf.o missing — run: make"; exit 2; }

# Distinctly-named copies of /bin/true, so each phase folds into a row we can
# assert on by name. A real binary per phase makes the expected count exact:
# `comm` is the fold identity, so there is no ambiguity about which exec came
# from where.
for m in mark-loop mark-child mark-thread; do
  cp /bin/true "$W/$m"
done
mkdir -p "$W/home/.ssh" && echo "not-a-key" > "$W/home/.ssh/id_rsa"
echo "payload" > "$W/blob.txt" && base64 "$W/blob.txt" > "$W/blob.b64"

# ── the workload ────────────────────────────────────────────────────────────
# Phases, in order:
#   setup   a child process and a python thread, both created BEFORE the probe
#           attaches — these are the two regressions. They idle on $W/go.
#   ready   touch $W/ready, then wait for $W/go
#   loop    50 × mark-loop            → folding, exact count
#   findings four commands that should each be flagged with a reason
#   pre     the child and the thread each run 10 × their marker
cat > "$W/workload.sh" <<'EOF'
set -u
W="$1"

# A child forked NOW, execing only after the probe is up. Before the scope
# fix this subtree was never seeded and contributed nothing.
bash -c '
  W="$1"; touch "$W/child-up"
  while [[ ! -e "$W/go" ]]; do sleep 0.05; done
  for i in $(seq 1 10); do "$W/mark-child"; done
' _ "$W" &

# A thread created NOW, spawning only after the probe is up. Before the fork
# key fix, membership was looked up by tid, so a thread that predated the seed
# was invisible and so was everything it spawned.
python3 -c '
import os, sys, time, threading, subprocess
W = sys.argv[1]
def worker():
    # Announce from INSIDE the thread: the test blocks on this file, so the OS
    # thread provably exists before the probe attaches. Without it, thread
    # creation raced capture startup — and on runs where the thread won that
    # race (created after seeding) a tid-keyed parent lookup still worked, so
    # the test passed against code that was broken. A flaky test that hides the
    # bug it exists to catch is worse than no test.
    open(W + "/thread-up", "w").write(str(threading.get_native_id()))
    while not os.path.exists(W + "/go"): time.sleep(0.05)
    for _ in range(10): subprocess.run([W + "/mark-thread"])
t = threading.Thread(target=worker); t.start(); t.join()
' "$W" &

touch "$W/ready"
while [[ ! -e "$W/go" ]]; do sleep 0.05; done

# Folding: one row, ×50.
for i in $(seq 1 50); do "$W/mark-loop"; done

# Findings: one exec each, every one a real program doing the real thing.
curl -s -o /dev/null "file://$W/blob.txt"      # fetches from the network
base64 -d "$W/blob.b64" > /dev/null            # evaluates constructed input
ls "$W/home/.ssh" > /dev/null                  # touches credential paths
chmod 777 "$W/blob.txt"                        # widens permissions

wait
EOF

# ── run it ──────────────────────────────────────────────────────────────────
bash "$W/workload.sh" "$W" >"$W/workload.log" 2>&1 &
ROOT=$!
# Wait for BOTH pre-existing subtrees to confirm they are up, not merely that
# the workload launched them — that is the precondition the whole test rests on.
for _ in $(seq 1 200); do
  [[ -e "$W/ready" && -e "$W/child-up" && -e "$W/thread-up" ]] && break
  sleep 0.05
done
for f in ready child-up thread-up; do
  [[ -e "$W/$f" ]] || { red "workload never signalled $f"; exit 2; }
done
dim "root pid $ROOT — child up, thread up (tid $(cat "$W/thread-up")), probe not yet attached"

# Release the workload once the probe has attached and seeded.
( sleep 3; touch "$W/go" ) &

dim "capturing for ${SECS}s …"
sudo yeet run src/probes/capture.js -- "$ROOT" "$SECS" >"$W/report.txt" 2>&1
[[ $VERBOSE == 1 ]] && cat "$W/report.txt"

# ── assertions ──────────────────────────────────────────────────────────────
fails=0
report="$W/report.txt"

# An exact folded count: `×50  ...  mark-loop`. Asserting the COUNT, not just
# presence, is the point — a partially-seeded scope shows the row but undercounts.
want_fold() { # name count
  if grep -qE "×$2 .*$1" "$report"; then
    grn "  ok    $1 folded ×$2"
  else
    got=$(grep -oE "×[0-9]+ [^ ]* *[0-9.]+% *$1" "$report" | grep -oE '×[0-9]+' | head -1)
    red "  FAIL  $1 expected ×$2, got ${got:-nothing}"
    fails=$((fails + 1))
  fi
}
want_finding() { # reason-substring label
  if grep -q "$1" "$report"; then
    grn "  ok    flagged: $2"
  else
    red "  FAIL  not flagged: $2 ($1)"
    fails=$((fails + 1))
  fi
}

echo
echo "capture completeness (exact counts):"
want_fold mark-loop 50
echo
echo "scope regressions — subtrees that existed before attach:"
want_fold mark-child 10
want_fold mark-thread 10
echo
echo "outlier tier — each of these should carry a reason:"
want_finding "fetches from the network"  "curl"
want_finding "evaluates constructed input" "base64 -d"
want_finding "touches credential paths" "ls ~/.ssh"
want_finding "widens permissions"      "chmod 777"

total=$(grep -oE '^=== [0-9]+ execs' "$report" | grep -oE '[0-9]+' | head -1)
echo
if [[ -n "$total" && "$total" -ge 74 ]]; then
  grn "  ok    $total execs captured (>= 74 known: 50 + 10 + 10 + 4)"
else
  red "  FAIL  total execs = ${total:-none}, expected at least 74"
  fails=$((fails + 1))
fi

echo
if [[ $fails == 0 ]]; then
  grn "PASS — the probe sees the whole tree, folds it, and flags the four findings"
else
  red "FAIL — $fails check(s) failed"
  dim "full report: cat $report   (or rerun with -v)"
  # Keep the report for inspection on failure.
  trap 'kill "${ROOT:-0}" 2>/dev/null' EXIT
  echo "report kept at $report" >&2
fi
exit $fails
