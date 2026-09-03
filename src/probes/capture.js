// Headless capture: seed a root, run the real probe through the real
// aggregation, and print the three tiers as text when the run ends.
//
// This exists to answer one question honestly — does the outlier pass surface
// things worth knowing on a REAL workload, or does it produce noise? A TUI
// would make that harder to judge, not easier.
//
//   sudo yeet run src/probes/capture.js -- <root-pid> [seconds]
//
// It also writes the raw normalized stream to /tmp/exectop-capture.json so a
// run can be replayed against changed heuristics without re-running the load.
import { ArrayMap, HashMap, RingBuf } from "yeet:bpf";
import { control } from "./probe.js";
import { normalize } from "../lib/argv.js";
import { createModel } from "../lib/model.js";
import { descendantsOf, procTable } from "../lib/scope.js";

const traced = new HashMap(control, "traced");
const events = new RingBuf(control, "events");
const statsMap = new ArrayMap(control, "stats_map");

// Kernel-side drop count. A non-zero value means the ring filled faster than
// it drained, so every number in the report is a floor rather than a total.
const dropped = async () => {
  try {
    const c = await statsMap.lookup(0);
    return Number(c?.dropped ?? 0);
  } catch {
    return 0;
  }
};

const root = Number(yeet.args?._?.[0] ?? 0);
const secs = Number(yeet.args?._?.[1] ?? 30);
if (!root) {
  console.log("usage: yeet run src/probes/capture.js -- <root-pid> [seconds]");
  yeet.exit();
}

const model = createModel();
const raw = [];

await traced.update({ tgid: root }, { depth: 0 });
// Seed the descendants that already exist, exactly as main.jsx does. Without
// this the capture only sees processes forked after we attach, so a root whose
// children (or whose threads) predate us reports a fraction of its tree.
const existing = descendantsOf(await procTable(), root);
for (const r of existing) await traced.update({ tgid: r.pid }, { depth: r.depth });
console.log(`[capture] root=${root} for ${secs}s (+${existing.length} existing)`);

const sub = await events.subscribe((w) => {
  const e = normalize(w);
  raw.push(e);
  model.add(e);
});

setTimeout(async () => {
  await report();
  yeet.exit();
}, secs * 1000);

async function report() {
  const total = model.total;
  const lost = await dropped();
  console.log(`\n=== ${total} execs in ${model.elapsed.toFixed(0)}s (${model.rate().toFixed(1)}/s)${lost ? ` — ${lost} DROPPED` : ""} ===\n`);
  if (lost) console.log(`[warn] ${lost} execs were dropped: the ring buffer filled faster than it drained, so every count below is a floor.\n`);

  console.log("-- doing --");
  for (const b of model.buckets()) {
    const pct = ((b.count / Math.max(1, total)) * 100).toFixed(1);
    console.log(`  ${b.label.padEnd(18)} ${String(b.count).padStart(5)}  ${pct.padStart(5)}%`);
  }

  console.log("\n-- doesn't fit --");
  const outs = model.outliers();
  if (!outs.length) console.log("  (nothing)");
  for (const o of outs) {
    console.log(`  ▲ ${o.fold.label.slice(0, 62).padEnd(62)} ${o.reasons.join(", ")}`);
  }

  console.log("\n-- folded (top 25) --");
  for (const f of model.folds().slice(0, 25)) {
    const pct = ((f.count / Math.max(1, total)) * 100).toFixed(1);
    console.log(`  ${String("×" + f.count).padStart(6)} ${pct.padStart(5)}%  ${f.label.slice(0, 78)}`);
  }
  console.log(`\n[capture] ${raw.length} raw records`);
}
