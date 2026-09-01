#!/usr/bin/env bash
# exectop demo (replay) — runs anywhere node does, no eBPF and no Linux.
#
# For the REAL tool against REAL kernel events, use demo/live.sh instead — it
# builds the probe in your Lima VM, generates live traffic, and hands you the
# actual TUI. This replay exists for machines with no VM, and for reproducing a
# specific captured stream against changed heuristics.
#
#   demo/run.sh            # menu
#   demo/run.sh sneaky     # straight to one workload
#   demo/run.sh --list
#
# It replays the captures in test/fixtures-* through src/lib/model.js — the
# same aggregation and outlier scoring the live TUI uses on real kernel data.
cd "$(dirname "$0")" && exec node replay.mjs "$@"
