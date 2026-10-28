// The sandbox verdict pass: given a net namespace per exec and a known root
// namespace, it must split sensitive commands into "ran outside the sandbox"
// vs "ran inside the sandbox" — and stay entirely dark when no root namespace
// is known (an ordinary exectop run must never grow sandbox findings).
//
//   node test/sandbox.test.mjs
import { createModel } from "../src/lib/model.js";
import { normalize } from "../src/lib/argv.js";

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

// ── normalize must keep every exec field (regression: the layer-2 edit once
//     truncated the exec record, dropping forkToExecUs → NaN in the tree) ───────
{
  const e = normalize({ exec_event: {
    ts_ns: 1n, fork_to_exec_ns: 470000n, pid: 5, ppid: 1, args_len: 3,
    depth: 1, netns: 100, truncated: 0, comm: "ls", args: new Uint8Array([108, 115, 0]),
  } });
  check("normalize keeps forkToExecUs", e.forkToExecUs === 470);
  check("normalize keeps truncated + netns", e.truncated === false && e.netns === 100);
}

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
  // The blocked side is NOT verified: a bwrap stand-in can't be confirmed from
  // the open (the hook sees the host mount ns). It states only the namespace
  // fact, and never claims verification.
  check("blocked says 'walled off', not 'stand-in'",
        /walled off/.test(blk?.detail ?? "") && !/stand-in/.test(blk?.detail ?? ""), blk?.detail);
  check("blocked is never marked verified", blk?.verified === false);
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

// ── blocked side is an unverified namespace statement ─────────────────
// Inside the sandbox ~/.ssh is a tmpfs mount, so a read of a file under it opens
// a path whose dentry walk stops at the mount root (leaf only, no ".ssh"). The
// join must still catch it because the exec argv named the credential path.
{
  const m = createModel({ hostNetns: () => HOST });
  m.add({ ...ev("cat", ["cat", "/home/u/.ssh/id_demo"], SBX), pid: 3001 });
  m.addOpen(open(3001, ["id_demo"], TMPFS)); // truncated: no ".ssh" component
  const v = m.verdicts();
  const blk = v.blocked.find((p) => p.fold.comm === "cat");
  // Even with a tmpfs open recorded, the blocked side stays an unverified
  // namespace statement — we do not trust the stand-in signal for bwrap.
  check("blocked stays 'walled off' and unverified", /walled off/.test(blk?.detail ?? "") && blk?.verified === false, blk?.detail);
}
// ── a later non-credential open must not hijack the verified path ──────────────
{
  const m = createModel({ hostNetns: () => HOST });
  m.add({ ...ev("cat", ["cat", "/home/u/.ssh/id_key"], HOST), pid: 4001 });
  m.addOpen(open(4001, ["id_key", ".ssh", "u", "home"], EXT4));    // the real key
  m.addOpen(open(4001, ["libc.so.6", "aarch64-linux-gnu", "lib"], EXT4)); // libc, same pid
  const v = m.verdicts();
  const p = v.past.find((x) => x.fold.comm === "cat");
  check("verified path names the credential file, not libc",
        /id_key/.test(p?.detail ?? "") && !/libc/.test(p?.detail ?? ""), p?.detail);
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

// ── a shell wrapper is folded away when its child command is itself shown ──────
{
  const m = createModel({ hostNetns: () => HOST });
  // sh -c 'cat ~/.ssh/key' and the cat it spawns — one action, two execs.
  m.add(ev("sh", ["sh", "-c", "cat /home/u/.ssh/id_key"], SBX));
  m.add(ev("cat", ["cat", "/home/u/.ssh/id_key"], SBX));
  const v = m.verdicts();
  check("shell wrapper folded away when child cat is shown",
        v.blocked.some((p) => p.fold.comm === "cat") &&
        !v.blocked.some((p) => /^sh -c cat/.test(p.fold.label)),
        v.blocked.map((p) => p.fold.label).join(" | "));
}
// ── but a bare shell that is itself sensitive stays ───────────────────────────
{
  const m = createModel({ hostNetns: () => HOST });
  // the shell reads the key directly in its own -c body, no child exec.
  m.add(ev("sh", ["sh", "-c", "read k < /home/u/.ssh/id_key"], HOST));
  const v = m.verdicts();
  check("a shell with no matching child command is kept",
        v.past.some((p) => /^sh -c/.test(p.fold.label)),
        v.past.map((p) => p.fold.label).join(" | "));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
