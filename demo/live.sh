#!/usr/bin/env bash
# exectop live demo — the REAL tool, real eBPF, in your Lima VM.
#
# Runs the actual probe against actual kernel exec events, with a workload
# generator driving traffic. Nothing is replayed and nothing is mocked.
#
#   demo/live.sh                 # menu
#   demo/live.sh build           # a real npm install with native compilation
#   demo/live.sh sketchy         # a postinstall that does suspicious things
#   demo/live.sh container       # attach to a running container
#   demo/live.sh noisy           # a busy loop, to watch folding work
#   demo/live.sh shell           # your own shell, watched live
#
# Host is macOS and eBPF is Linux, so it works in the Lima VM. The host repo is
# mounted read-only there, so this syncs to a writable copy and builds in the
# VM (the playbook's rule).
set -euo pipefail

VM="${EXECTOP_VM:-yeet.debian-13}"
REMOTE="\$HOME/exectop-demo"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# yeet:tui needs a real terminal. `limactl shell` only allocates a PTY when its
# own stdin IS one, so bail early with a useful message rather than failing deep
# inside the VM with "Terminal IO failed: No such device or address".
[[ -t 0 && -t 1 ]] || die "demo/live.sh needs an interactive terminal (it renders a TUI).
Run it directly in your terminal, not through a pipe or redirect."
say() { printf '\033[2m%s\033[0m\n' "$*"; }

command -v limactl >/dev/null || die "limactl not found — this demo needs Lima (brew install lima)"
limactl list "$VM" --format '{{.Status}}' 2>/dev/null | grep -q Running \
  || die "VM '$VM' is not running. Start it with:  limactl start $VM"

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  cat <<MENU

  $(printf '\033[1;38;5;117mexectop\033[0m') $(printf '\033[2m— live demo, real eBPF in %s\033[0m' "$VM")

    $(printf '\033[33m1\033[0m')  build       a real npm install with native compilation
    $(printf '\033[33m2\033[0m')  sketchy     a postinstall that fetches, chmods and reads ~/.ssh
    $(printf '\033[33m3\033[0m')  noisy       a busy loop — watch repetition fold
    $(printf '\033[33m4\033[0m')  container   attach to a running container
    $(printf '\033[33m5\033[0m')  shell       watch a shell, and type commands into it yourself

  $(printf '\033[2mpick 1-5:\033[0m ')
MENU
  read -rsn1 pick
  case "$pick" in
    1) MODE=build ;; 2) MODE=sketchy ;; 3) MODE=noisy ;;
    4) MODE=container ;; 5) MODE=shell ;;
    *) echo; exit 0 ;;
  esac
  echo
fi

# ── sync + build in the VM ───────────────────────────────────────────────────
say "[1/3] syncing to $VM:$REMOTE"
limactl shell "$VM" -- bash -lc "mkdir -p $REMOTE"
COPYFILE_DISABLE=1 tar czf - -C "$(dirname "$HERE")" \
    --exclude=.git --exclude=toolchain --exclude=node_modules \
    "$(basename "$HERE")" 2>/dev/null \
  | limactl shell "$VM" -- bash -lc "tar xzf - --strip-components=1 -C $REMOTE 2>/dev/null"

say "[2/3] building (clang + bpftool + esbuild)"
limactl shell "$VM" -- bash -lc "cd $REMOTE && make" >/dev/null 2>&1 \
  || { limactl shell "$VM" -- bash -lc "cd $REMOTE && make" ; die "build failed"; }

# ── the workload generators ──────────────────────────────────────────────────
limactl shell "$VM" -- bash -lc "cat > /tmp/es-workload.sh" <<'WL'
#!/bin/bash
# Workloads for the exectop live demo. Each is real work, not a simulation.
set -u
case "${1:-}" in
build)
  mkdir -p /tmp/es-build-demo && cd /tmp/es-build-demo
  cat > package.json <<'J'
{ "name": "es-demo", "version": "1.0.0",
  "dependencies": { "bufferutil": "^4.0.8", "utf-8-validate": "^6.0.3" } }
J
  rm -rf node_modules package-lock.json
  exec npm install --no-audit --no-fund
  ;;
sketchy)
  # A benign fixture that performs the SHAPES exectop flags: it fetches over
  # file://, decodes base64, widens permissions and lists ~/.ssh. It downloads
  # nothing from the network and changes nothing outside /tmp.
  mkdir -p /tmp/es-sketchy && cd /tmp/es-sketchy
  cat > package.json <<'J'
{ "name": "sketchy", "version": "1.0.0", "scripts": { "postinstall": "bash ./setup.sh" } }
J
  cat > setup.sh <<'S'
#!/bin/bash
for i in $(seq 1 12); do /bin/echo "preparing $i" >/dev/null; done
mkdir -p vendor
curl -fsS file:///etc/hostname -o vendor/pb.tgz 2>/dev/null || true
chmod 777 vendor
echo "ZWNobyBoaQ==" | base64 -d > vendor/x.sh 2>/dev/null || true
ls ~/.ssh >/dev/null 2>&1 || true
for i in $(seq 1 12); do /bin/echo "finishing $i" >/dev/null; done
S
  chmod +x setup.sh
  rm -rf node_modules package-lock.json
  exec npm install --no-audit --no-fund
  ;;
noisy)
  # Deliberately repetitive, so folding is obvious: thousands of execs, a
  # handful of distinct commands.
  while true; do
    for i in $(seq 1 20); do
      /bin/echo "unit $i" >/dev/null
      /bin/date +%s >/dev/null
      /usr/bin/head -c 8 /dev/null >/dev/null
    done
    /bin/mkdir -p /tmp/es-noisy && /bin/rm -rf /tmp/es-noisy
    sleep 0.3
  done
  ;;
container)
  docker rm -f exectop-demo >/dev/null 2>&1 || true
  docker run -d --name exectop-demo alpine:3 sh -c '
    while true; do
      for i in 1 2 3 4 5 6; do /bin/echo "request $i" >/dev/null; /bin/date >/dev/null; done
      /bin/mkdir -p /tmp/w; /bin/rm -rf /tmp/w
      /bin/cat /etc/hostname >/dev/null
      sleep 1
    done' >/dev/null
  echo exectop-demo
  ;;
esac
WL
limactl shell "$VM" -- bash -lc "chmod +x /tmp/es-workload.sh"

say "[3/3] starting"
echo
printf '\033[2m  ↑/↓ move · ⏎ expand a fold · tab switch pane · p pause · q quit\033[0m\n\n'
sleep 1

case "$MODE" in
  build|sketchy)
    # Launch mode: bin/exectop parks the target with SIGSTOP until the probe
    # is attached, so the process tree is complete from the very first exec.
    limactl shell "$VM" -- bash -lc \
      "cd $REMOTE && ./bin/exectop -- bash /tmp/es-workload.sh $MODE"
    ;;
  noisy)
    limactl shell "$VM" -- bash -lc \
      "cd $REMOTE && ./bin/exectop -- bash /tmp/es-workload.sh noisy"
    ;;
  container)
    NAME=$(limactl shell "$VM" -- bash -lc "/tmp/es-workload.sh container" | tail -1)
    say "  container '$NAME' is up and generating work"
    sleep 2
    limactl shell "$VM" -- bash -lc \
      "cd $REMOTE && ./bin/exectop --container $NAME"
    limactl shell "$VM" -- bash -lc "docker rm -f $NAME >/dev/null 2>&1 || true"
    ;;
  shell)
    # Attach to a real interactive shell. Open a SECOND terminal, run the
    # printed command, and every process you launch shows up live.
    say "  starting a shell to watch…"
    limactl shell "$VM" -- bash -lc \
      "setsid bash -c 'exec sleep 3600' </dev/null >/dev/null 2>&1 & sleep 1; true"
    PID=$(limactl shell "$VM" -- bash -lc "pgrep -n -f 'exec sleep 3600' || pgrep -n -f 'sleep 3600'")
    cat <<EOS

  Watching pid $PID. In ANOTHER terminal, run:

      limactl shell $VM

  …then run anything (ls, git status, make, npm install) and watch it appear.
  Note: only processes forked AFTER attach are tracked — that is the honest
  limit of attaching to something already running.

EOS
    read -rsn1 -p "  press any key to start… "; echo
    limactl shell "$VM" -- bash -lc "cd $REMOTE && ./bin/exectop --pid $PID"
    ;;
  *) die "unknown mode: $MODE (try build, sketchy, noisy, container, shell)" ;;
esac
