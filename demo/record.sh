#!/usr/bin/env bash
# exectop — the recording demo. A 60-second run built for capturing a GIF.
#
#   demo/record.sh            # run it, sized 100x30 for a README
#   demo/record.sh --cast     # also record an asciinema .cast next to it
#
# It is the REAL tool on REAL kernel exec events in the Lima VM. The workload
# (demo/showcase.sh) does genuine work — gcc actually compiles, curl actually
# fetches over file:// — and is paced in four phases so the screen is never
# still and the findings land one at a time on camera:
#
#   0-14s  resolving      shell + text plumbing, steady ~15/s
#  14-34s  compiling      gcc/cc1/as, the compiler bars grow
#  34-46s  post-install   the four sketchy things arrive, spaced ~1.5s apart
#  46-60s  tests          steady activity, findings stay on screen
#
# Nothing leaves the machine and nothing outside /tmp is modified.
set -euo pipefail

VM="${EXECTOP_VM:-yeet.debian-13}"
REMOTE="\$HOME/exectop-demo"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COLS="${EXECTOP_COLS:-100}"
ROWS="${EXECTOP_ROWS:-30}"

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
say() { printf '\033[2m%s\033[0m\n' "$*"; }

command -v limactl >/dev/null || die "limactl not found (brew install lima)"
limactl list "$VM" --format '{{.Status}}' 2>/dev/null | grep -q Running \
  || die "VM '$VM' is not running:  limactl start $VM"
[[ -t 0 && -t 1 ]] || die "record.sh renders a TUI — run it in a real terminal."

say "[1/3] syncing to $VM"
limactl shell "$VM" -- bash -lc "mkdir -p $REMOTE"
COPYFILE_DISABLE=1 tar czf - -C "$(dirname "$HERE")" \
    --exclude=.git --exclude=toolchain --exclude=node_modules "$(basename "$HERE")" 2>/dev/null \
  | limactl shell "$VM" -- bash -lc "tar xzf - --strip-components=1 -C $REMOTE 2>/dev/null"

say "[2/3] building"
limactl shell "$VM" -- bash -lc "cd $REMOTE && make" >/dev/null 2>&1 \
  || { limactl shell "$VM" -- bash -lc "cd $REMOTE && make"; die "build failed"; }

# Resize the terminal so the capture is a predictable size. Saved and restored.
resize() { printf '\033[8;%d;%dt' "$2" "$1"; }
OLD_COLS=$(tput cols); OLD_ROWS=$(tput lines)
resize "$COLS" "$ROWS"
trap 'resize "$OLD_COLS" "$OLD_ROWS"' EXIT INT TERM
sleep 0.4

say "[3/3] starting — 60s, four phases"
printf '\033[2m      resolving → compiling → post-install hooks → tests\033[0m\n'
printf '\033[2m      the sketchy things show up around 35s\033[0m\n\n'
sleep 1.5
clear

RUN="cd $REMOTE && ./bin/exectop -- bash demo/showcase.sh"

if [[ "${1:-}" == "--cast" ]]; then
  command -v asciinema >/dev/null || die "asciinema not found (brew install asciinema)"
  OUT="${EXECTOP_CAST:-$HERE/demo/exectop.cast}"
  rm -f "$OUT"
  asciinema rec --overwrite --cols "$COLS" --rows "$ROWS" \
    --command "limactl shell $VM -- bash -lc '$RUN'" "$OUT"
  printf '\n\033[2mcast written: %s\033[0m\n' "$OUT"
  printf '\033[2mto GIF:  agg %s %s\033[0m\n' "$OUT" "${OUT%.cast}.gif"
else
  limactl shell "$VM" -- bash -lc "$RUN"
fi
