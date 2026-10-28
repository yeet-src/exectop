// The sandbox verdict pass: given a net namespace per exec and a known root
// namespace, it must split sensitive commands into "ran outside the sandbox"
// vs "ran inside the sandbox" — and stay entirely dark when no root namespace
// is known (an ordinary exectop run must never grow sandbox findings).
//
//   node test/sandbox.test.mjs
import { createModel } from "../src/lib/model.js";

const HOST = 4026531840;   // the agent's own namespace
const SBX = 4026532355;    // bwrap's unshared namespace

// Minimal exec record; argv + netns are what the verdict pass reads.
let ts = 0;
const ev = (comm, argv, netns) => ({
  ts: (ts += 10), pid: 1000, ppid: 999, comm, argv, netns,
  depth: 1, forkToExecUs: 300, truncated: false,
});

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failed++;
};

// ── without a known root namespace, the dimension is OFF ──────────────────────
{
  const m = createModel(); // no hostNetns thunk → returns 0
  for (let i = 0; i < 3; i++) m.add(ev("ls", ["ls", "-la", "/home/u/.ssh"], SBX));
  const v = m.verdicts();
  check("no root netns → not detected", v.detected === false);
  check("no root netns → no findings", v.past.length === 0 && v.blocked.length === 0);
  check("no root netns → sandboxDetected() false", m.sandboxDetected() === false);
}

// ── the real escape run: one ls ~/.ssh blocked, one got past ──────────────────
{
  const m = createModel({ hostNetns: () => HOST });
  // First attempt, inside the sandbox (empty stand-in).
  m.add(ev("ls", ["ls", "-la", "/home/u/.ssh"], SBX));
  m.add(ev("ssh", ["ssh", "-T", "git@github.com"], SBX));
  // Retry outside the sandbox (reached the real files / network).
  m.add(ev("ls", ["ls", "-la", "/home/u/.ssh"], HOST));
  m.add(ev("ssh", ["ssh", "-T", "git@github.com"], HOST));
  // Ordinary work, both sides — must never show up as a finding.
  m.add(ev("cc1", ["cc1", "-O2", "a.c"], SBX));
  m.add(ev("node", ["node", "build.js"], HOST));

  const v = m.verdicts();
  check("escape run → detected", v.detected === true);
  check("escape run → 2 got past (ls, ssh)", v.past.length === 2,
        v.past.map((p) => p.fold.comm).join(","));
  check("escape run → 2 blocked (ls, ssh)", v.blocked.length === 2,
        v.blocked.map((p) => p.fold.comm).join(","));

  const pastLs = v.past.find((p) => p.fold.comm === "ls");
  check("got-past ls names credential paths", /credential paths/.test(pastLs?.reach ?? ""),
        pastLs?.detail);
  check("got-past ls says 'outside the sandbox'", /outside the sandbox/.test(pastLs?.detail ?? ""));
  const blockedSsh = v.blocked.find((p) => p.fold.comm === "ssh");
  check("blocked ssh says 'inside the sandbox'", /inside the sandbox/.test(blockedSsh?.detail ?? ""));
  check("compile never a sandbox finding",
        ![...v.past, ...v.blocked].some((p) => p.fold.comm === "cc1" || p.fold.comm === "node"));
}

// ── a launcher is not itself a finding ────────────────────────────────────────
{
  const m = createModel({ hostNetns: () => HOST });
  // unshare runs in the host namespace and its argv carries `ls ~/.ssh`; it is
  // the thing that MAKES the sandbox, not a command reaching credentials.
  m.add(ev("unshare", ["unshare", "-rn", "sh", "-c", "ls ~/.ssh"], HOST));
  // the real child runs inside the new namespace.
  m.add(ev("ls", ["ls", "-la", "/home/u/.ssh"], SBX));
  const v = m.verdicts();
  check("launcher (unshare) is not a got-past finding",
        !v.past.some((p) => p.fold.comm === "unshare"),
        v.past.map((p) => p.fold.comm).join(","));
  check("the child ls is blocked", v.blocked.some((p) => p.fold.comm === "ls"));
  check("launcher excluded → nothing got past", v.past.length === 0);
}

// ── sandbox held: everything sensitive stayed inside ──────────────────────────
{
  const m = createModel({ hostNetns: () => HOST });
  m.add(ev("ls", ["ls", "-la", "/home/u/.ssh"], SBX));
  m.add(ev("ssh", ["ssh", "-T", "git@github.com"], SBX));
  m.add(ev("cc1", ["cc1", "-O2", "a.c"], HOST));
  const v = m.verdicts();
  check("held run → detected", v.detected === true);
  check("held run → nothing got past", v.past.length === 0);
  check("held run → 2 blocked", v.blocked.length === 2);
}

// ── file-open evidence upgrades the wording to a kernel fact ───────────────────
const EXT4 = 0xef53;
const TMPFS = 0x1021994;
const open = (pid, comps, magic) => ({ pid, comps, magic, isDir: false, comm: "cat", netns: 0, ts: 0 });
{
  const m = createModel({ hostNetns: () => HOST });
  // outside: cat reads the real key (ext4); inside: cat sees the tmpfs stand-in.
  m.add({ ...ev("cat", ["cat", "/home/u/.ssh/id_key"], HOST), pid: 2001 });
  m.addOpen(open(2001, ["id_key", ".ssh", "u", "home"], EXT4));
  m.add({ ...ev("cat", ["cat", "/home/u/.ssh/id_key"], SBX), pid: 2002 });
  m.addOpen(open(2002, ["id_key", ".ssh"], TMPFS));
  const v = m.verdicts();
  const past = v.past.find((p) => p.fold.comm === "cat");
  const blk = v.blocked.find((p) => p.fold.comm === "cat");
  check("open evidence → got-past says 'opened your real'", /opened your real/.test(past?.detail ?? ""), past?.detail);
  check("got-past is marked verified", past?.verified === true);
  check("open evidence → blocked says 'empty stand-in'", /empty stand-in/.test(blk?.detail ?? ""), blk?.detail);
  check("blocked is marked verified", blk?.verified === true);
}
// without open evidence it falls back to the argv inference, not a false claim.
{
  const m = createModel({ hostNetns: () => HOST });
  m.add(ev("ssh", ["ssh", "-T", "git@github.com"], HOST));
  const v = m.verdicts();
  const p = v.past.find((x) => x.fold.comm === "ssh");
  check("no open evidence → wording stays an inference", /its command reaches/.test(p?.detail ?? ""), p?.detail);
  check("no open evidence → not marked verified", !p?.verified);
}

// ── stand-in open joins by pid even when the path is truncated ─────────────────
// Inside the sandbox ~/.ssh is a tmpfs mount, so a read of a file under it opens
// a path whose dentry walk stops at the mount root (leaf only, no ".ssh"). The
// join must still catch it because the exec argv named the credential path.
{
  const m = createModel({ hostNetns: () => HOST });
  m.add({ ...ev("cat", ["cat", "/home/u/.ssh/id_demo"], SBX), pid: 3001 });
  m.addOpen(open(3001, ["id_demo"], TMPFS)); // truncated: no ".ssh" component
  const v = m.verdicts();
  const blk = v.blocked.find((p) => p.fold.comm === "cat");
  check("truncated stand-in open still joins → 'empty stand-in'", /empty stand-in/.test(blk?.detail ?? ""), blk?.detail);
  check("truncated stand-in → verified", blk?.verified === true);
}
// ── mount / sh -c mount set up the sandbox; never a credential finding ─────────
{
  const m = createModel({ hostNetns: () => HOST });
  m.add(ev("mount", ["mount", "-t", "tmpfs", "tmpfs", "/home/u/.ssh"], SBX));
  m.add(ev("sh", ["sh", "-c", "mount -t tmpfs tmpfs /home/u/.ssh"], SBX));
  const v = m.verdicts();
  check("mount is not a sandbox finding",
        ![...v.past, ...v.blocked].some((p) => p.fold.comm === "mount"),
        [...v.past, ...v.blocked].map((p) => p.fold.comm).join(","));
  check("sh -c mount is not a finding",
        ![...v.past, ...v.blocked].some((p) => /^sh -c mount/.test(p.fold.label)));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
