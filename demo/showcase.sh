#!/usr/bin/env bash
# A 60-second workload built for recording: real programs, real exec events,
# paced in phases so the screen is never still and the findings arrive one at a
# time rather than in a clump.
#
# Everything is genuine work — gcc actually compiles, curl actually fetches
# (over file://, nothing leaves the machine), base64 actually decodes. The only
# engineered part is the TIMING, so a recording has a shape.
#
# Deliberately varied in rate: bursts and lulls, so the sparkline shows a
# profile instead of a flat line. Timings were tuned by measuring the real run,
# not guessed — the first pass ran 2x fast and had every finding on screen by
# t+25s, leaving half the recording static.
#
# Launched by demo/record.sh inside the VM. Not meant to be run directly.
set -u

W=/tmp/es-showcase
rm -rf "$W"; mkdir -p "$W/src" "$W/vendor"; cd "$W"

for i in $(seq 1 26); do
  cat > "src/mod$i.c" <<EOF
#include <stdio.h>
static int helper$i(int x){ return x * $i; }
int mod$i(void){ return helper$i($i); }
EOF
done
printf '#include <stdio.h>\nint main(void){ printf("built\\n"); return 0; }\n' > src/main.c

# A burst of cheap execs, then a pause — this is what gives the sparkline shape.
burst() {  # burst <count> <label>
  local n="$1" label="$2" i
  for i in $(seq 1 "$n"); do
    /bin/echo "$label $i" >/dev/null
    /bin/date +%s >/dev/null
  done
}

# ── phase 1 (0-15s): resolving — spiky, shell and text plumbing ─────────────
phase_resolve() {
  for round in 1 2 3 4 5; do
    burst 14 "resolve package"
    printf 'dep\n' | /usr/bin/tr 'a-z' 'A-Z' | /usr/bin/head -1 >/dev/null
    /bin/mkdir -p "$W/vendor/p$round"
    sleep 1.6          # the lull that makes the burst visible
  done
}

# ── phase 2 (15-36s): the build — compiler-heavy, steady ───────────────────
# 26 files at ~0.75s each. gcc fans out to cc1 + as, so each file is 3 execs
# and the compiling bar climbs the whole phase instead of jumping once.
phase_build() {
  local i
  for i in $(seq 1 26); do
    gcc -Wall -O2 -c "src/mod$i.c" -o "src/mod$i.o" 2>/dev/null
    /bin/echo "  CC src/mod$i.c" >/dev/null
    sleep 0.55
  done
  gcc -c src/main.c -o src/main.o 2>/dev/null
  gcc -o app src/*.o 2>/dev/null
}

# ── phase 3 (36-50s): post-install hooks — the sketchy things ──────────────
# Spaced ~3s apart so each lands on camera alone and the ▲ panel grows a line
# at a time. This is the part a viewer is meant to watch happen.
phase_hooks() {
  burst 6 "postinstall step"; sleep 1.2

  curl -fsS file:///etc/hostname -o vendor/prebuilt.tgz 2>/dev/null || true
  sleep 3.0

  burst 5 "linking"; sleep 0.8
  chmod 777 vendor 2>/dev/null || true
  sleep 3.0

  burst 5 "verifying"; sleep 0.8
  /bin/echo "ZWNobyBidWlsZCBob29rCg==" | /usr/bin/base64 -d > vendor/hook.sh 2>/dev/null || true
  sleep 3.0

  burst 4 "finalizing"; sleep 0.8
  /bin/ls "$HOME/.ssh" >/dev/null 2>&1 || true
  sleep 2.0
}

# ── phase 4 (50-62s): tests — steady, unremarkable, findings stay up ───────
phase_test() {
  local i
  for i in $(seq 1 30); do
    /bin/echo "test case $i" >/dev/null
    /usr/bin/seq 1 3 | /usr/bin/awk '{s+=$1} END{print s}' >/dev/null
    ./app >/dev/null 2>&1 || true
    sleep 0.35
  done
}

phase_resolve
phase_build
phase_hooks
phase_test
sleep 8   # a stable final frame to end the recording on
