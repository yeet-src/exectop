#!/usr/bin/env node
// exectop demo — the real UI, the real aggregation, real captured data.
//
// eBPF is Linux-only, so this runs the checked-in captures (test/fixtures-*)
// through src/lib/model.js — the same aggregation and the same outlier scoring
// the live TUI uses. Only two things differ from the real thing: the events
// come from a file instead of a ring buffer, and the rendering is plain ANSI
// rather than yeet:tui (which needs the daemon).
//
//   demo/run.sh                 # pick a workload from a menu
//   demo/run.sh sneaky          # go straight to one
//   demo/run.sh --list
//
// ↑/↓ move · ⏎ expand a fold · tab switch pane · space pause · q quit
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createModel, foldKey } from "../src/lib/model.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "test");

// Each capture, with what it is and what the panel SHOULD say. The expectation
// is printed on exit so the demo is falsifiable rather than just pretty.
const WORKLOADS = {
  npm:        { file: "fixtures-npm-install.jsonl", label: "npm install (native addons)", scope: "launched pid 4242", expect: "silent — every command is ordinary build work" },
  cbuild:     { file: "fixtures-cbuild.jsonl",      label: "C build via make",            scope: "launched pid 4242", expect: "silent — and 9 per-file compiles fold to 3 rows of ×9" },
  legit:      { file: "fixtures-legit.jsonl",       label: "build that curls 6 times",    scope: "launched pid 4242", expect: "silent — repeated fetching is this build's normal" },
  suspicious: { file: "fixtures-suspicious.jsonl",  label: "sketchy npm postinstall",     scope: "launched pid 4242", expect: "4 findings — fetch, base64, chmod 777, ~/.ssh" },
  sneaky:     { file: "fixtures-sneaky.jsonl",      label: "one ssh read in 40 echoes",   scope: "container my-app",  expect: "1 finding — the needle, found in the haystack" },
};

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const [k, w] of Object.entries(WORKLOADS)) console.log(`  ${k.padEnd(11)} ${w.label}`);
  process.exit(0);
}

const load = (file) =>
  readFileSync(join(FIX, file), "utf8")
    .split("\n").filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));

// ── palette (mirrors src/lib/format.js) ──────────────────────────────────────
const rgb = (r, g, b) => (t) => `\x1b[38;2;${r};${g};${b}m${t}\x1b[39m`;
const bgRgb = (r, g, b) => (t) => `\x1b[48;2;${r};${g};${b}m${t}\x1b[49m`;
const bold = (t) => `\x1b[1m${t}\x1b[22m`;
const C = {
  brand: rgb(125, 211, 252), title: rgb(240, 246, 252), text: rgb(235, 240, 245),
  dim: rgb(120, 130, 140), faint: rgb(80, 88, 98), ok: rgb(74, 222, 128),
  warn: rgb(250, 204, 21), bad: rgb(248, 113, 113), flash: rgb(255, 255, 255),
  selBg: bgRgb(38, 66, 104), rail: bgRgb(28, 32, 38), cap: bgRgb(52, 58, 66),
};
const BUCKET = {
  compile: rgb(199, 168, 255), runtime: rgb(125, 211, 252), shell: rgb(163, 230, 53),
  files: rgb(94, 234, 212), text: rgb(148, 163, 184), vcs: rgb(253, 186, 116),
  net: rgb(248, 113, 113), other: rgb(120, 130, 140),
};
const bucketOf = (c) =>
  /^(cc1|cc1plus|cc|gcc|g\+\+|clang|clang\+\+|as|ld|ar|ranlib|collect2|make|cmake|ninja)$/.test(c) ? "compile" :
  /^(node|python3?|ruby|perl|deno|bun|npm|npx|yarn|pnpm|node-gyp-build)$/.test(c) ? "runtime" :
  /^(sh|bash|dash|zsh)$/.test(c) ? "shell" :
  /^(rm|mv|cp|mkdir|rmdir|install|tar|gzip|gunzip|unzip|xz|chmod|chown|touch|ln)$/.test(c) ? "files" :
  /^(sed|awk|grep|egrep|fgrep|printf|echo|cat|head|tail|cut|tr|sort|uniq|wc|tee|seq|expr|test|true|false|env|which|date|sleep|uname|id|stat|find|xargs|ls|pwd)$/.test(c) ? "text" :
  /^(git|hg|svn)$/.test(c) ? "vcs" :
  /^(curl|wget|nc|ncat|socat|ssh|scp|sftp|rsync|openssl|base64)$/.test(c) ? "net" : "other";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, n) => { const w = strip(s).length; return w >= n ? s : s + " ".repeat(n - w); };
const lpad = (s, n) => { const w = strip(s).length; return w >= n ? s : " ".repeat(n - w) + s; };
const clip = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…");
const bar = (f, w) => { const n = Math.max(0, Math.min(w, Math.round(f * w))); return "█".repeat(n) + "·".repeat(w - n); };
const SPARK = "▁▂▃▄▅▆▇█";
const sparkline = (v, w) => { const s = v.slice(-w); if (!s.length) return ""; const m = Math.max(1, ...s); return s.map((x) => SPARK[Math.min(7, Math.floor((x / m) * 7.99))]).join(""); };
const fmtCount = (n) => { const s = String(Math.round(n)); let o = ""; for (let i = 0; i < s.length; i++) { if (i > 0 && (s.length - i) % 3 === 0) o += ","; o += s[i]; } return o; };
const fmtMs = (us) => (us < 1000 ? `${Math.round(us)}µs` : us < 1e6 ? `${(us / 1000).toFixed(1)}ms` : `${(us / 1e6).toFixed(1)}s`);
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ── pick a workload ──────────────────────────────────────────────────────────
const out = process.stdout;
let key = args.find((a) => !a.startsWith("-"));

if (!key) {
  console.log(`\n  ${bold(C.brand("exectop"))} ${C.dim("— demo. Replays real captures through the real aggregation.")}\n`);
  const keys = Object.keys(WORKLOADS);
  keys.forEach((k, i) => {
    const w = WORKLOADS[k];
    const n = load(w.file).length;
    console.log(`  ${C.warn(String(i + 1))}  ${pad(bold(C.text(w.label)), 42)} ${C.faint(`${n} execs`)}`);
  });
  console.log(`\n  ${C.dim("pick 1-" + keys.length + ", or q to quit")}\n`);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  key = await new Promise((res) => {
    process.stdin.on("data", (b) => {
      const s = b.toString();
      if (s === "q" || s === "\x03") { out.write("\n"); process.exit(0); }
      const i = parseInt(s, 10);
      if (i >= 1 && i <= keys.length) res(keys[i - 1]);
    });
  });
  process.stdin.setRawMode?.(false);
}

const wl = WORKLOADS[key];
if (!wl) { console.error(`unknown workload: ${key}\nknown: ${Object.keys(WORKLOADS).join(", ")}`); process.exit(1); }

// ── replay ───────────────────────────────────────────────────────────────────
const recs = load(wl.file);
const model = createModel();
const flashes = new Map();
const state = { focus: "tree", treeSel: 0, treeTop: 0, outSel: 0, expanded: new Set(), paused: false, done: false };

// The captures carry no timestamps, so replay them at a readable pace. Real
// builds burst far faster than this; the point here is that you can watch the
// tree assemble and the findings appear.
const PACE_MS = 45;
let idx = 0;
model.seed(999, key === "sneaky" ? "sh" : "npm");

const size = () => ({ cols: out.columns || 100, rows: out.rows || 40 });

out.write("\x1b[?1049h\x1b[?25l");
const cleanup = () => {
  out.write("\x1b[?25h\x1b[?1049l");
  const outs = model.outliers();
  console.log(`\n  ${bold(C.text(wl.label))}  ${C.faint(`${model.total} execs → ${model.folds().length} folds`)}`);
  console.log(`  ${C.dim("expected:")} ${wl.expect}`);
  console.log(`  ${C.dim("actual:  ")} ${outs.length ? C.bad(`${outs.length} finding${outs.length > 1 ? "s" : ""}: `) + outs.map((o) => o.fold.label).join(", ") : C.ok("silent")}\n`);
  process.exit(0);
};
process.on("SIGINT", cleanup);

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (b) => {
  const k = b.toString();
  const folds = model.folds(), outs = model.outliers();
  if (k === "q" || k === "\x03" || k === "\x1b") return cleanup();
  if (k === "\t") state.focus = state.focus === "tree" ? "outliers" : "tree";
  else if (k === " ") state.paused = !state.paused;
  else if (k === "\x1b[A" || k === "k") {
    if (state.focus === "tree") { state.treeSel = Math.max(0, state.treeSel - 1); if (state.treeSel < state.treeTop) state.treeTop = state.treeSel; }
    else state.outSel = Math.max(0, state.outSel - 1);
  } else if (k === "\x1b[B" || k === "j") {
    if (state.focus === "tree") state.treeSel = Math.min(folds.length - 1, state.treeSel + 1);
    else state.outSel = Math.min(Math.max(0, outs.length - 1), state.outSel + 1);
  } else if (k === "\r" || k === "\n") {
    if (state.focus === "tree") {
      const f = folds[state.treeSel];
      if (f) state.expanded.has(f.key) ? state.expanded.delete(f.key) : state.expanded.add(f.key);
    } else {
      const o = outs[state.outSel];
      if (o) { const i = folds.findIndex((f) => f.key === o.fold.key); if (i >= 0) { state.focus = "tree"; state.treeSel = i; state.expanded.add(o.fold.key); } }
    }
  }
});

const feed = setInterval(() => {
  if (state.paused || idx >= recs.length) { if (idx >= recs.length) state.done = true; return; }
  const r = recs[idx++];
  const e = { ts: Date.now(), pid: 4300 + idx, ppid: 999, comm: r.comm, argv: r.argv,
              depth: r.d ?? 1, forkToExecUs: 120 + Math.round(idx * 7) % 900, truncated: false };
  model.add(e);
  flashes.set(foldKey(e), Date.now() + 700);
}, PACE_MS);

const draw = () => {
  const { cols, rows } = size();
  const now = Date.now();
  for (const [k, exp] of flashes) if (exp < now) flashes.delete(k);
  const L = [];
  const rule = (label, on) => {
    const l = on ? `${label} ▸` : label;
    return C.faint("── ") + C.dim(l) + C.faint(" " + "─".repeat(Math.max(0, cols - l.length - 5)));
  };

  L.push(C.rail(pad(" " + bold(C.brand("exectop")) + C.faint("  ▏  ") + C.dim("scope ") +
    C.text(wl.scope) + C.faint("  ▏  ") +
    (state.paused ? C.warn("‖ paused") : state.done ? C.dim("replay complete") : C.dim("replaying capture")), cols - 1)));

  const total = model.total;
  const bs = model.buckets(), outs = model.outliers(), folds = model.folds();

  L.push("");
  if (!total) L.push(C.dim("  waiting for the first exec…"));
  else L.push("  " + bold(C.title(`${fmtCount(total)} execs`)) + C.dim(` · `) +
    bold(C.title(`${model.rate().toFixed(0)}/s`)) + C.faint("   " + sparkline(model.spark(), Math.min(40, cols - 44))));
  if (total) {
    const top = bs[0];
    L.push("  " + C.dim("mostly ") + (top ? (BUCKET[top.id] ?? C.text)(bold(top.label)) + C.dim(` (${((top.count / total) * 100).toFixed(0)}% of execs)`) : "") +
      C.dim(" · ") + (outs.length ? C.bad(bold(`${outs.length} thing${outs.length > 1 ? "s" : ""} that don't fit`)) : C.ok("nothing out of place")));
  } else L.push("");

  L.push(rule("doing"));
  const barW = Math.max(8, Math.min(30, cols - 33));
  for (const b of bs.slice(0, 6)) {
    const f = b.count / Math.max(1, total), col = BUCKET[b.id] ?? C.text;
    L.push("  " + col(pad(b.label, 17)) + col(bar(f, barW)) + lpad(C.text(String(b.count)), 7) + C.dim(lpad(`${(f * 100).toFixed(1)}%`, 7)));
  }

  L.push(rule("doesn't fit", state.focus === "outliers"));
  if (!outs.length) L.push("  " + C.ok("nothing out of place — every command looks like ordinary build work"));
  else {
    const nameW = Math.max(20, Math.floor(cols * 0.42));
    outs.forEach((o, i) => {
      const sel = state.focus === "outliers" && i === state.outSel;
      const line = "  " + C.bad("▲ ") + pad(bold(C.text(clip(o.fold.label, nameW))), nameW) +
        C.dim("  " + clip(o.reasons.join(", "), Math.max(12, cols - nameW - 8)));
      L.push(sel ? C.selBg(pad(line, cols - 1)) : line);
    });
  }

  L.push(rule("every exec, repetition folded", state.focus === "tree"));
  const nameW = Math.max(24, Math.floor(cols * 0.46));
  const tBarW = Math.max(8, Math.min(16, cols - 76));
  L.push(C.faint("  " + pad("  command", nameW + 4) + lpad("count", 5) + "   " + pad("share", tBarW + 8) + lpad("fork→exec", 9) + "  parent"));

  const head = L.length;
  const budget = Math.max(3, rows - head - 2);
  if (state.treeSel >= state.treeTop + budget) state.treeTop = state.treeSel - budget + 1;
  const ft = Math.max(0, Math.min(state.treeTop, Math.max(0, folds.length - budget)));

  const body = [];
  for (let i = ft; i < folds.length && body.length < budget; i++) {
    const f = folds[i];
    const sel = state.focus === "tree" && i === state.treeSel;
    const exp = state.expanded.has(f.key);
    const col = BUCKET[bucketOf(f.comm)] ?? C.text;
    const share = f.count / Math.max(1, total);
    const fresh = (flashes.get(f.key) ?? 0) > now;
    const nm = clip(f.label, nameW);
    const line = "  " + C.dim(exp ? "▾ " : f.count > 1 ? "▸ " : "  ") +
      pad(fresh ? bold(C.flash(nm)) : col(nm), nameW) +
      lpad(bold(C.text(f.count > 1 ? `×${f.count}` : "×1")), 7) + "  " + col(bar(share, tBarW)) +
      C.dim(lpad(`${(share * 100).toFixed(1)}%`, 7)) + C.dim(lpad(fmtMs(median(f.lats)), 9)) +
      C.faint("  " + clip([...f.parents].join(","), 14));
    body.push(sel ? C.selBg(pad(line, cols - 1)) : line);
    if (exp) {
      for (const s of f.samples.slice(-6)) {
        if (body.length >= budget) break;
        body.push("    " + C.faint("↳ ") + C.dim(clip(s.argv.join(" "), Math.max(20, cols - 26))) + C.faint(lpad(`pid ${s.pid}`, 12)));
      }
      if (f.count > 6 && body.length < budget) body.push("    " + C.faint(`↳ …${f.count - 6} more`));
    }
  }
  L.push(...body);
  while (L.length < rows - 1) L.push("");

  const cap = (k, d) => C.cap(bold(C.warn(` ${k} `))) + C.dim(` ${d}   `);
  L.push(C.rail(pad("  " + cap("↑↓", "move") + cap("⏎", "expand") + cap("tab", "pane") +
    cap("space", state.paused ? "resume" : "pause") + cap("q", "quit"), cols - 1)));

  out.write("\x1b[H\x1b[2J" + L.slice(0, rows).join("\n"));
};

setInterval(draw, 80);
draw();
