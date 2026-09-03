#!/usr/bin/env bash
# Ring-buffer drop accounting.
#
# Delivery is bound by bytes moved, not events: a 1 KiB record caps the ring at
# roughly 2,700 execs/s. A parallel fork storm outruns that by an order of
# magnitude, and the events that do not fit are lost. That is a real limit and
# it is fine; losing them SILENTLY is not, because every count on screen then
# reads as a total when it is a floor.
#
# This asserts the accounting closes: captured + dropped == what actually ran.
# Run it in the VM after `make`.
set -uo pipefail
cd "$(dirname "$0")/.."

WORKERS=${WORKERS:-24}
PER=${PER:-4000}
EXPECT=$((WORKERS * PER))

g="\033[32m"; r="\033[31m"; d="\033[2m"; z="\033[0m"
fail=0
ok()   { printf "${g}  ok    %s${z}\n" "$1"; }
bad()  { printf "${r}  FAIL  %s${z}\n" "$1"; fail=$((fail+1)); }

cat > /tmp/exectop-storm.sh <<STORM
#!/bin/bash
sleep 3
for w in \$(seq 1 $WORKERS); do ( for i in \$(seq 1 $PER); do /bin/true; done ) & done
wait
sleep 6
STORM
chmod +x /tmp/exectop-storm.sh

printf "${d}firing %d execs across %d workers …${z}\n" "$EXPECT" "$WORKERS"
setsid /tmp/exectop-storm.sh >/dev/null 2>&1 </dev/null &
sleep 1
ROOT=$(pgrep -n -f /tmp/exectop-storm.sh)
[ -n "$ROOT" ] || { echo "could not start the storm"; exit 1; }

OUT=$(timeout 60 yeet run src/probes/capture.js -- "$ROOT" 25 2>&1)
CAPTURED=$(printf '%s' "$OUT" | grep -oE '^=== [0-9]+ execs' | grep -oE '[0-9]+' | head -1)
DROPPED=$(printf '%s' "$OUT" | grep -oE '— [0-9]+ DROPPED' | grep -oE '[0-9]+' | head -1)
DROPPED=${DROPPED:-0}
CAPTURED=${CAPTURED:-0}
TOTAL=$((CAPTURED + DROPPED))

echo
echo "captured=$CAPTURED  dropped=$DROPPED  sum=$TOTAL  expected>=$EXPECT"
echo

# The point of the test: nothing vanishes unaccounted for. Shell overhead adds
# a little (seq, sleep, the subshells), so the sum is a floor, and the slack is
# for scheduling, not for losses.
if [ "$TOTAL" -ge "$EXPECT" ]; then
  ok "accounting closes: captured + dropped >= $EXPECT"
else
  bad "accounting leaks: $TOTAL < $EXPECT — $((EXPECT - TOTAL)) execs vanished uncounted"
fi

# A storm this size must actually overrun the ring. If it does not, either the
# machine got much faster or the storm is no longer a storm, and the drop path
# is then untested rather than passing.
if [ "$DROPPED" -gt 0 ]; then
  ok "drops are reported, not silent ($DROPPED)"
else
  bad "no drops at $EXPECT execs — the drop path went untested; raise WORKERS/PER"
fi

# And the warning has to reach the reader.
if printf '%s' "$OUT" | grep -q "were dropped"; then
  ok "the report says the counts are a floor"
else
  bad "drops counted but never explained in the output"
fi

echo
if [ "$fail" -eq 0 ]; then
  printf "${g}PASS — every exec is either captured or counted as dropped${z}\n"
else
  printf "${r}FAIL — %d check(s) failed${z}\n" "$fail"
fi
exit "$fail"
