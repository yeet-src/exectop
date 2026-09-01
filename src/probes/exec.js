// The exec stream as reactive signals. Seeds the traced set, subscribes to the
// ring buffer once, feeds the pure aggregation in lib/model.js, and exposes
// what the UI reads. The only BPF-aware module besides probe.js.
import { signal } from "yeet:tui";
import { DataSec, HashMap, RingBuf } from "yeet:bpf";
import { control } from "./probe.js";
import { normalize } from "../lib/argv.js";
import { createModel, foldKey } from "../lib/model.js";

const events = new RingBuf(control, "events");
const traced = new HashMap(control, "traced");
const bss = new DataSec(control, "probe.bss");

const model = createModel();

// A fold flashes for a moment after it fires, so an exec that lived 3ms is
// still visible on screen. Map of foldKey -> expiry ms.
export const flashes = new Map();
const FLASH_MS = 700;

export const status = signal("starting");
export const paused = signal(false);
// Mirror of `paused` as a plain boolean. The ring-buffer callback must NOT read
// a signal: it fires outside the reactive graph, and a signal read there is
// both meaningless and (with a render in flight) a guard violation that gets
// swallowed by the subscription — every event silently dropped, no error
// anywhere. Cost real debugging time. main.jsx flips this through setPaused().
let pausedFlag = false;
export const setPaused = (v) => { pausedFlag = v; paused.set(v); };

// Seed the traced set with the root pid at depth 0. Everything below it is
// added in-kernel at fork, so this is the only write JS makes.
export async function seedRoot(pid, comm) {
  await traced.update({ tgid: pid }, { depth: 0 });
  // Name the root in the model too, so its direct children show a parent name
  // instead of "?". The kernel only tells us a ppid; the comm for a process we
  // never saw exec has to come from here.
  model.seed(pid, comm ?? String(pid));
}

// Narrow to a cgroup (0 = the pid subtree alone, no cgroup filter).
export async function setCgroup(cgid) {
  await bss.patch({ target_cgid: cgid });
}

// One subscription, driving one model.
//
// The subscription is started EAGERLY here rather than inside `from()`. A
// from() producer doesn't run until something watches it, and the playbook's
// warning applies to the real UI too: with the ring buffer opened lazily, the
// stream never turns on if the first read happens outside a reactive context,
// and the whole screen sits empty forever. Cost real debugging time — the TUI
// rendered exactly one frame and never updated.
//
// `tick` is a plain signal that bumps on each coalesced batch. Components read
// it inside a thunk, which is what makes them re-render.
export const tick = signal(0);

// When the last exec arrived, and when we attached. Silence is a real reading
// here, not a missing one: a running service execs at startup and then
// essentially never again, so "nothing for four minutes" is the honest answer
// for most production scopes — and it is worth SAYING, rather than leaving a
// "waiting…" that reads like a broken probe.
let attachedAt = Date.now();
let lastExecAt = 0;
export const idle = () => ({
  sinceAttach: (Date.now() - attachedAt) / 1000,
  sinceExec: lastExecAt ? (Date.now() - lastExecAt) / 1000 : null,
});

let dirty = false;
let beats = 0;
// AWAITED: RingBuf.subscribe() returns a Promise and does not attach until it
// resolves. Fire-and-forget leaves the ring buffer unattached, the model empty,
// and the UI frozen on its first frame with no error anywhere. This module is
// imported from main.jsx, which is top-level-await, so awaiting here is safe.
await events.subscribe((w) => {
  if (pausedFlag) return;
  const e = normalize(w);
  model.add(e);
  lastExecAt = Date.now();
  flashes.set(foldKey(e), Date.now() + FLASH_MS);
  dirty = true;
});

// Coalesce: a build can burst hundreds of execs between frames, and rendering
// per event would spend the budget on work the eye cannot see. The flash decay
// also needs a heartbeat, so tick advances even when the stream is briefly
// quiet but flashes are still fading.
setInterval(() => {
  const fading = flashes.size > 0;
  // Tick at least once a second even with nothing arriving, so the idle line
  // counts up instead of freezing at whatever it said when the stream stopped.
  const heartbeat = ++beats % 10 === 0;
  if (dirty || fading || heartbeat) {
    dirty = false;
    const now = Date.now();
    for (const [k, exp] of flashes) if (exp < now) flashes.delete(k);
    tick.update((v) => v + 1);
  }
}, 100);

// Projections. Each reads `tick` so it recomputes when the stream advances.
export const stats = () => ({
  total: model.total,
  elapsed: model.elapsed,
  rate: model.rate(),
  spark: model.spark(),
});
export const buckets = () => model.buckets();
export const outliers = () => model.outliers();
export const folds = () => model.folds();
