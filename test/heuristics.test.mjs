// The regression test that matters: the outlier pass must fire on real
// suspicious behavior and stay SILENT on real benign builds. Every fixture is
// an actual capture from the live probe against a real workload — none are
// synthesized, because the synthetic version of this test passed while the
// heuristics were badly wrong.
//
//   node test/heuristics.test.mjs
import { readFileSync } from "node:fs";
import { createModel } from "../src/lib/model.js";

const load = (f) =>
  readFileSync(new URL(f, import.meta.url), "utf8")
    .split("\n").filter((l) => l.startsWith("{"))
    .map((l, i) => {
      const r = JSON.parse(l);
      return { ts: i * 10, pid: 1000 + i, ppid: 999, comm: r.comm,
               argv: r.argv, depth: r.d ?? 1, forkToExecUs: 300, truncated: false };
    });

const run = (f) => {
  const m = createModel();
  for (const r of load(f)) m.add(r);
  return m;
};

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failed++;
};

// ── benign builds must be silent ─────────────────────────────────────────────
// A false alarm costs more trust than a miss, so this half of the suite is the
// one that matters most. Each of these is ordinary work start to finish.
const BENIGN = [
  ["npm install with native addons", "./fixtures-npm-install.jsonl"],
  ["a C build via make",             "./fixtures-cbuild.jsonl"],
  // The important one: a build that legitimately curls SIX times and chmods.
  // Rarity gating is what keeps this quiet — repeated fetching is that build's
  // normal, while a single unexplained fetch is not.
  ["repeated legitimate curl",       "./fixtures-legit.jsonl"],
];
for (const [name, f] of BENIGN) {
  const m = run(f);
  const outs = m.outliers();
  check(`${name} → no findings`, outs.length === 0,
        outs.map((o) => `${o.fold.label} (${o.reasons.join(", ")})`).join("; "));
}

// Folding must actually fold. Pre-fix, npm was 53 folds for 114 execs, which
// made every count ~1 and every fold look rare.
const npm = run("./fixtures-npm-install.jsonl");
check("npm folds well under exec count", npm.folds().length < 40,
      `${npm.folds().length} folds / ${npm.total} execs`);

// Nine C files should collapse to a handful of rows, not stay as 27.
const cbuild = run("./fixtures-cbuild.jsonl");
check("C build folds per-file compiles", cbuild.folds().length <= 10,
      `${cbuild.folds().length} folds / ${cbuild.total} execs`);

// ── suspicious behavior must fire ────────────────────────────────────────────
const bad = run("./fixtures-suspicious.jsonl");
const badReasons = bad.outliers().flatMap((o) => o.reasons).join(" ");
for (const want of ["fetches from the network", "evaluates constructed input",
                    "widens permissions", "touches credential paths"]) {
  check(`suspicious postinstall → "${want}"`, badReasons.includes(want));
}

// The needle case: ONE credential read buried in 40 identical echoes. This is
// what the folding is for — compress the noise so the one thing surfaces.
const sneaky = run("./fixtures-sneaky.jsonl");
const sOut = sneaky.outliers();
check("one ssh read among 40 echoes → exactly 1 finding", sOut.length === 1,
      sOut.map((o) => o.fold.label).join("; "));
check("  …and it names the credential path",
      sOut[0]?.reasons?.some((r) => r.includes("credential")));

// ── the original design error must not come back ─────────────────────────────
// Rarity alone flagged a third of a real build. It gates now; it never scores.
for (const [name, f] of [...BENIGN, ["suspicious", "./fixtures-suspicious.jsonl"],
                         ["sneaky", "./fixtures-sneaky.jsonl"]]) {
  const only = run(f).outliers().filter((o) =>
    o.reasons.length === 1 && o.reasons[0] === "ran once");
  check(`rarity alone is never a finding (${name})`, only.length === 0);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
