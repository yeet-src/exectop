/* exectop — every process an application launches.
 *
 * It answers a question no flat exec tracer does: not "what execs happened on
 * this host" but "what is THIS application doing". Scope comes first (a
 * container, a launched command, a pid subtree, maintained in-kernel across
 * fork), then the stream is folded so repetition reads as one row, then the
 * handful of things that don't look like ordinary build work are ranked on top.
 *
 *   kernel → user : probes/probe.js loads the object; probes/exec.js seeds the
 *                   traced set, subscribes to the ring buffer, and feeds the
 *                   pure aggregation in lib/model.js.
 *
 * Layout: probes/ (BPF-aware) → components/ (pure UI) → lib/ (pure helpers),
 * composed here. This file owns view state and all keyboard input.
 *
 * Three tiers, top to bottom: a verdict, behavior buckets, then the outliers
 * and the folded tree. Read downward to go from "what is it doing" to "show me
 * the exact command".
 */
import { Box, Text, computed, mount, signal } from "yeet:tui";
import {
  buckets, flashes, folds, idle, outliers, paused, seedRoot, setCgroup, setPaused, stats, status, tick,
} from "@/probes/exec.js";
import { commOf, containerRoot, listContainers } from "@/lib/scope.js";
import { C_FAINT, C_DIM } from "@/lib/format.js";
import TitleBar from "@/components/titlebar.jsx";
import Verdict from "@/components/verdict.jsx";
import Buckets from "@/components/buckets.jsx";
import Outliers from "@/components/outliers.jsx";
import Tree, { TreeHeader } from "@/components/tree.jsx";
import Footer from "@/components/footer.jsx";

// ── scope ────────────────────────────────────────────────────────────────────
const scope = signal("resolving…");
const args = yeet.args ?? {};

async function resolveScope() {
  const container = args.container ?? args.c;
  const pid = Number(args.pid ?? args.p ?? 0);

  if (container) {
    let c;
    try {
      c = await containerRoot(container);
    } catch (err) {
      // A wrong container name is the most likely mistake here, so say what
      // IS running rather than just failing.
      const names = (await listContainers()).filter((x) => x.state === "RUNNING").map((x) => x.name);
      throw new Error(
        `${err.message}${names.length ? `\n  running: ${names.join(", ")}` : ""}`,
      );
    }
    await seedRoot(c.pid, c.comm);
    scope.set(`container ${c.label}`);
    status.set(c.cgroup ? "cgroup-scoped" : "pid-subtree");
    return;
  }
  if (pid) {
    await seedRoot(pid, await commOf(pid));
    if (args.launched) {
      // bin/exectop parked the target with SIGSTOP before it exec'd, so the
      // probe attached before it ran anything: the tree really is complete.
      scope.set(`launched pid ${pid}`);
      status.set("complete tree — target was parked until the probe attached");
    } else {
      scope.set(`pid ${pid}`);
      // Anything this pid forked before we attached is invisible until it
      // forks again — say so rather than implying the tree is complete.
      status.set("pid-subtree (pre-existing children not tracked)");
    }
    return;
  }
  // No scope given: seed pid 1 so fork propagation covers the host. Honest
  // about being unscoped rather than pretending to be targeted.
  await seedRoot(1, "systemd");
  scope.set("whole host");
  status.set("unscoped — pass --container or --pid to narrow");
}

await resolveScope();

// ── view state ───────────────────────────────────────────────────────────────
const focus = signal("tree"); // "tree" | "outliers"
const treeSel = signal(0);
const treeTop = signal(0);
const outSel = signal(0);
const expanded = signal(new Set());

const treeFocused = computed(() => focus.get() === "tree");
const outFocused = computed(() => focus.get() === "outliers");

// Rows available to the tree. The tree sits in a height="1fr" Box, so the
// layout already hands it the leftover space — this only has to agree with
// that, and any disagreement is a real bug: emitting more rows than the
// viewport has makes the renderer write at absolute positions past the bottom
// of the screen, which shows up as stale fragments smeared across the panels.
//
// It reads the reactive `size` signal, NOT tty.size(). tty.size() is a
// separate read that can disagree with the size the render tree is currently
// laid out for, and that disagreement was exactly the corruption above.
const CHROME = 2;                       // title rail + footer rail
const VERDICT = 2;                      // two verdict lines
const RULES = 3;                        // "doing", "doesn't fit", "folded"
const TREE_HEADER = 1;                  // the column labels
// `rows` is passed in as a thunk over the same size signal the layout uses.
// Writing a signal here instead would trip the set-during-render guard.
const treeBudgetFor = (rows) => {
  const bCount = Math.min(6, Math.max(1, buckets().length));
  const oCount = Math.max(1, Math.min(6, outliers().length));
  return Math.max(3, rows - CHROME - VERDICT - RULES - TREE_HEADER - bCount - oCount);
};

const keepVisible = () => {
  const sel = treeSel.get();
  // Outside the render pass (this runs from key handlers), so reading tty.size()
  // directly is fine and avoids threading the signal through every caller.
  const budget = treeBudgetFor(tty.size().rows);
  let t = treeTop.get();
  if (sel < t) t = sel;
  if (sel >= t + budget) t = sel - budget + 1;
  treeTop.set(Math.max(0, t));
};

const move = (d) => {
  if (focus.get() === "tree") {
    const n = folds().length;
    treeSel.set(Math.max(0, Math.min(n - 1, treeSel.get() + d)));
    keepVisible();
  } else {
    const n = outliers().length;
    outSel.set(Math.max(0, Math.min(Math.max(0, n - 1), outSel.get() + d)));
  }
};

const toggleExpand = () => {
  const f = folds()[treeSel.get()];
  if (!f) return;
  // Replace the Set rather than mutate it: a signal only notifies on set().
  const next = new Set(expanded.get());
  next.has(f.key) ? next.delete(f.key) : next.add(f.key);
  expanded.set(next);
};

// Selecting a finding drops the cursor onto that fold in the tree, expanded —
// the one keystroke from "something's off" to "here is the exact command".
const dropIntoTree = () => {
  const o = outliers()[outSel.get()];
  if (!o) return;
  const i = folds().findIndex((f) => f.key === o.fold.key);
  if (i < 0) return;
  const next = new Set(expanded.get());
  next.add(o.fold.key);
  expanded.set(next);
  focus.set("tree");
  treeSel.set(i);
  keepVisible();
};

// The daemon reports return as either "Enter" or "Return" depending on the
// input path, so accept both (mongosnoop and pktscope do the same).
const isEnter = (code) => code === "Enter" || code === "Return";

// ── input ────────────────────────────────────────────────────────────────────
tty.enableMouse();

tty.on("keydown", (e) => {
  const code = e.code;
  const k = (e.key ?? "").toLowerCase();
  if (code === "Escape" || k === "q") return yeet.exit();
  if (code === "Tab") return focus.set(focus.get() === "tree" ? "outliers" : "tree");
  if (k === "p") return setPaused(!paused.get());
  if (isEnter(code) || k === " ") {
    return focus.get() === "tree" ? toggleExpand() : dropIntoTree();
  }
  if (code === "ArrowDown" || k === "j") return move(1);
  if (code === "ArrowUp" || k === "k") return move(-1);
  if (code === "PageDown") return move(10);
  if (code === "PageUp") return move(-10);
  if (k === "g") return (treeSel.set(0), treeTop.set(0));
});

tty.on("wheel", (e) => move(e.deltaY > 0 ? 3 : -3));

// ── layout ───────────────────────────────────────────────────────────────────
const Rule = ({ label, width, focused }) => (
  <Text height="1" break="none" fg={C_FAINT}>
    {() => {
      const l = focused?.get?.() ? `${label} ▸` : label;
      return "── " + l + " " + "─".repeat(Math.max(0, width() - l.length - 5));
    }}
  </Text>
);

const Root = (size) => {
  // `width` is a THUNK, never a snapshot. Passing size.get().cols as a plain
  // value reads the signal during view construction, which freezes that whole
  // subtree for the life of the process — the runtime warns about exactly this
  // ("signal read with .get() during view construction"), and it cost real
  // debugging time here: the screen rendered once and never updated again.
  const width = () => size.get().cols;
  return (
    <Box>
      <TitleBar scope={scope} status={status} paused={paused} />
      <Verdict tick={tick} stats={stats} buckets={buckets} outliers={outliers} idle={idle} width={width} />
      <Rule label="doing" width={width} />
      <Buckets tick={tick} stats={stats} buckets={buckets} width={width} maxRows={6} />
      <Rule label="doesn't fit" width={width} focused={outFocused} />
      <Outliers tick={tick} outliers={outliers} total={() => stats().total}
                selected={outSel} focused={outFocused} width={width} maxRows={6} />
      <Rule label="every exec, repetition folded" width={width} focused={treeFocused} />
      <TreeHeader width={width} />
      <Box height="1fr" overflow="hidden">
        <Tree tick={tick} folds={folds} flashes={flashes} selected={treeSel} expanded={expanded}
              focused={treeFocused} top={treeTop} width={width} maxRows={() => treeBudgetFor(size.get().rows)} />
      </Box>
      <Footer paused={paused} />
    </Box>
  );
};

mount(Root);
await new Promise(() => {}); // keep the script alive; the TUI owns the screen
