// Aggregation + outlier scoring. Pure JS over the exec stream: it takes
// normalized exec records (see lib/argv.js) and rolls them into the three
// tiers the UI shows — a verdict, behavior buckets, and a folded tree with
// the things that don't fit ranked on top.
//
// No BPF here by design. The same functions run against a recorded stream,
// which is how the outlier heuristics get tested without a kernel.

// A "verb" is a subcommand that changes what the tool DOES (`git rev-parse`,
// `npm run`, `docker build`). Keeping it in the fold key stops `git gc` folding
// into `git log`.
//
// Only tools that actually have subcommands get this treatment. Applying it to
// everything was a real bug: `echo u1`, `echo u2` … each became its own fold,
// so fifty echoes read as fifty distinct commands instead of one row of ×50.
const VERBED = /^(git|npm|npx|yarn|pnpm|docker|podman|cargo|go|kubectl|systemctl|apt|apt-get|dnf|yum|pip|pip3|brew|make|gh|hg|svn)$/;
const isVerb = (a) => /^[a-z][a-z0-9-]{1,20}$/.test(a);

// `-DFOO=bar` and `-DFOO=baz` are the same flag; `-I/a` and `-I/b` likewise.
// Fold on the flag NAME, dropping any attached value.
const flagName = (a) => a.replace(/[=:].*$/, "").replace(/^(-[A-Za-z])(?=[^-]).*$/, "$1");

// The fold key decides what counts as "the same thing happening again".
// argv[0] + the verb + the FLAG set, with positional paths dropped: `cc1 -quiet
// a.c` and `cc1 -quiet b.c` fold together, `cc1 -O2 ...` stays separate.
//
// Heuristic, in the same spirit as redissnoop's key-pattern grouping: an
// unusual argv scheme may fold in ways you don't expect.

// A `sh -c` script's identity is the COMMAND it runs, not its text. Build
// systems generate a fresh script per target — node-gyp emits paths, printf
// recipes, even comment-only lines — so folding on the text shatters one
// recipe into dozens of one-off rows, which then read as anomalies. Fold on
// the first real command word instead.
//
// Measured on a real `npm install` with native addons: folding on script text
// gave 53 folds for 114 execs and an outlier panel that was entirely Makefile
// mechanics. Folding on the leading command collapses that to the handful of
// distinct things the build actually does.
const shScriptFold = (script) => {
  const s = script.trim();
  // Comment-only recipe lines are real execs but carry no command at all.
  if (/^#/.test(s)) return "#comment";
  // Strip a leading `cd ... &&` / env assignments, then take the first word.
  const body = s
    .replace(/^\s*cd\s+[^&;|]+(&&|;)\s*/, "")
    .replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, "");
  const first = body.split(/[\s;|&(]+/).find(Boolean) ?? "";
  return first.replace(/^.*\//, "") || "?";
};

const isShellC = (comm, rest) =>
  /^(sh|bash|dash|zsh)$/.test(comm) && rest.includes("-c");

export const foldKey = (e) => {
  const rest = e.argv.slice(1);
  if (isShellC(e.comm, rest))
    return e.comm + " -c " + shScriptFold(rest[rest.indexOf("-c") + 1] ?? "");
  // Dedupe: a compiler line carries `-I` once per include path, and `-I a -I b`
  // vs `-I a -I b -I c` are the same KIND of invocation. Without the dedupe the
  // flag multiset differs per file and every compile becomes its own fold.
  const flags = [...new Set(rest.filter((a) => a.startsWith("-")).map(flagName))].sort();
  const verb = VERBED.test(e.comm) && rest.length && isVerb(rest[0]) ? " " + rest[0] : "";
  return e.comm + verb + (flags.length ? " " + flags.join(" ") : "");
};

// Human-readable form of the fold: the command with paths elided.
export const foldLabel = (e) => {
  const rest = e.argv.slice(1);
  if (isShellC(e.comm, rest)) {
    const f = shScriptFold(rest[rest.indexOf("-c") + 1] ?? "");
    return f === "#comment" ? `${e.comm} -c ⟨comment⟩` : `${e.comm} -c ${f} …`;
  }
  const out = [e.comm];
  let elided = 0;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("-")) out.push(a);
    else if (i === 0 && VERBED.test(e.comm) && isVerb(a)) out.push(a);
    else elided++;
  }
  if (elided) out.push(`\u27e8${elided} arg${elided > 1 ? "s" : ""}\u27e9`);
  return out.join(" ");
};

export function createModel() {
  const folds = new Map();   // key -> {key,label,comm,count,firstTs,lastTs,lats[],parents:Set,samples[]}
  const parentComm = new Map(); // pid -> comm, so we can name a child's parent
  let total = 0;
  // Rate history for the sparkline. 500ms buckets over 60s: at a realistic
  // build rate (10-40 execs/s) one-second buckets are all within a hair of
  // each other and the line renders dead flat, which says nothing.
  const BUCKET_MS = 500;
  const NBUCKETS = 120;
  const rateBuckets = new Array(NBUCKETS).fill(0);
  let t0 = Date.now();
  let lastBucket = 0;

  const seed = (pid, comm) => parentComm.set(pid, comm);

  const add = (e) => {
    total++;
    parentComm.set(e.pid, e.comm);
    const key = foldKey(e);
    let f = folds.get(key);
    if (!f) {
      f = { key, label: foldLabel(e), comm: e.comm, count: 0, firstTs: e.ts,
            lastTs: e.ts, lats: [], parents: new Set(), samples: [] };
      folds.set(key, f);
    }
    f.count++;
    f.lastTs = e.ts;
    f.lats.push(e.forkToExecUs);
    f.parents.add(parentComm.get(e.ppid) ?? "?");
    if (f.samples.length < 40) f.samples.push(e);
    // Bucket on WALL CLOCK, not e.ts. e.ts comes from the kernel's ktime and is
    // boot-relative, so (e.ts - t0) against a Date.now() epoch is a huge
    // negative number: every event landed in one bucket and the sparkline was
    // always flat. A real bug, and invisible until a demo needed the shape.
    const b = Math.floor((Date.now() - t0) / BUCKET_MS);
    // Zero the buckets we skipped over, so a gap reads as a gap rather than
    // carrying a stale count from the previous lap of the ring.
    if (b > lastBucket) {
      for (let i = lastBucket + 1; i <= b && i - lastBucket <= NBUCKETS; i++) {
        rateBuckets[i % NBUCKETS] = 0;
      }
      lastBucket = b;
    }
    rateBuckets[b % NBUCKETS]++;
  };

  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  // Outliers — "what doesn't fit", and the hardest thing here to get right.
  //
  // The first version scored on RARITY: in a repetitive stream, the thing that
  // ran once is the interesting one. Measured against a real `npm install`
  // that turned out to be false. 11 of 34 folds were singletons — a third of
  // the tree — because a build genuinely does most things exactly once. Rarity
  // alone flags a third of everything, which is not a detector.
  //
  // So rarity is now necessary but NOT sufficient: it gates, it doesn't score.
  // A fold must ALSO do something a build step has no business doing. Every
  // reason below is a property of the observed exec, never an inference about
  // intent, and the bar is mongosnoop's — a false alarm costs more than a miss.
  const outliers = () => {
    const all = [...folds.values()];
    if (!all.length) return [];
    const globalMed = median(all.flatMap((f) => f.lats));

    const scored = [];
    for (const f of all) {
      // Gate: common things are not outliers, whatever else they do. An
      // absolute count, NOT a share — share is scale-dependent in exactly the
      // wrong direction: in a 10-exec run one exec is 10% and a share gate
      // silently skips everything, so a short stream detects nothing at all.
      if (f.count > 3) continue;

      const reasons = [];
      let score = 0;
      const full = f.samples.map((s) => s.argv.join(" ")).join(" \n");

      // Reaches the network. A compiler doesn't open sockets; a build step
      // that fetches is worth seeing even when it's legitimate.
      if (/^(curl|wget|nc|ncat|socat|ssh|scp|sftp|rsync)$/.test(f.comm)) {
        reasons.push("fetches from the network"); score += 50;
      }
      // Pipes a download straight into an interpreter.
      if (/\|\s*(sh|bash|python3?|node|perl|ruby)\b/.test(full) &&
          /\b(curl|wget)\b/.test(full)) {
        reasons.push("pipes a download into a shell"); score += 60;
      }
      // Evaluates constructed text.
      if (/\beval\b/.test(full) || /\bbase64\s+-d\b/.test(full)) {
        reasons.push("evaluates constructed input"); score += 45;
      }
      // Widens permissions.
      if (/^chmod$/.test(f.comm) && /\b(777|a\+w|o\+w|\+s)\b/.test(full)) {
        reasons.push("widens permissions"); score += 40;
      }
      if (/^(chown|setcap|sudo|su|doas)$/.test(f.comm)) {
        reasons.push("changes privileges"); score += 35;
      }
      // Touches credential-shaped paths.
      // Match the directory itself as well as paths inside it — `ls ~/.ssh`
      // carries the same signal as reading a key out of it.
      if (/(\/\.ssh\b|\/\.aws\b|\/\.netrc\b|\/\.docker\/config|id_rsa|id_ed25519|\.pem\b|credentials)/.test(full)) {
        reasons.push("touches credential paths"); score += 45;
      }
      // Reads from outside the build, into a writable temp path.
      if (/^(tar|unzip|gunzip)$/.test(f.comm) && /\/tmp\//.test(full)) {
        reasons.push("unpacks into /tmp"); score += 20;
      }
      // A stall, which is a performance finding rather than a safety one.
      const med = median(f.lats);
      if (globalMed > 0 && med > globalMed * 20 && f.count > 1) {
        reasons.push(`fork→exec ${(med / 1000).toFixed(0)}ms vs ${(globalMed / 1000).toFixed(1)}ms median`);
        score += 25;
      }

      if (!reasons.length) continue; // rarity alone is not a finding
      if (f.count === 1) { reasons.unshift("ran once"); score += 10; }
      if (score >= 35) scored.push({ fold: f, score, reasons });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 6);
  };

  // Behavior buckets — the "what is this thing doing" layer, above the tree.
  const BUCKETS = [
    { id: "compile",  label: "compiling",       test: (c) => /^(cc1|cc1plus|cc|gcc|g\+\+|clang|clang\+\+|as|ld|ar|ranlib|collect2|make|cmake|ninja)$/.test(c) },
    { id: "runtime",  label: "running scripts", test: (c) => /^(node|python3|python|ruby|perl|deno|bun)$/.test(c) },
    { id: "shell",    label: "shelling out",    test: (c) => /^(sh|bash|dash|zsh)$/.test(c) },
    { id: "files",    label: "moving files",    test: (c) => /^(rm|mv|cp|mkdir|rmdir|install|tar|gzip|gunzip|unzip|xz|chmod|chown|touch|ln)$/.test(c) },
    { id: "text",     label: "text plumbing",   test: (c) => /^(sed|awk|grep|egrep|fgrep|printf|echo|cat|head|tail|cut|tr|sort|uniq|wc|tee|seq|expr|test|true|false|env|which|date|sleep|uname|id|stat|find|xargs|ls|pwd)$/.test(c) },
    { id: "vcs",      label: "version control", test: (c) => /^(git|hg|svn)$/.test(c) },
    { id: "net",      label: "network",         test: (c) => /^(curl|wget|nc|ncat|socat|ssh|scp|sftp|rsync|openssl|base64)$/.test(c) },
  ];

  const buckets = () => {
    const out = BUCKETS.map((b) => ({ ...b, count: 0 }));
    let other = 0;
    for (const f of folds.values()) {
      const b = out.find((x) => x.test(f.comm));
      if (b) b.count += f.count; else other += f.count;
    }
    if (other) out.push({ id: "other", label: "other", count: other });
    return out.filter((b) => b.count > 0).sort((a, b) => b.count - a.count);
  };

  // The CURRENT rate, over the last few seconds — not a cumulative average.
  // A running average sags toward zero as a run goes on (17/s -> 9/s while the
  // work is still going), which misreads as the build slowing down when it
  // hasn't. The recent window tracks what is actually happening now.
  const RATE_WINDOW = 10; // buckets of BUCKET_MS = last 5 seconds
  const rate = () => {
    const now = Math.floor((Date.now() - t0) / BUCKET_MS);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < RATE_WINDOW && now - i >= 0; i++) {
      sum += rateBuckets[(now - i + NBUCKETS) % NBUCKETS];
      n++;
    }
    if (!n) return 0;
    return sum / (n * (BUCKET_MS / 1000));
  };

  return {
    add, seed,
    get total() { return total; },
    get elapsed() { return (Date.now() - t0) / 1000; },
    folds: () => [...folds.values()].sort((a, b) => b.count - a.count),
    outliers, buckets, rate,
    spark: () => {
      const now = Math.floor((Date.now() - t0) / BUCKET_MS);
      // Zero anything between the last recorded event and now, so a stream that
      // has stopped shows the line fall away instead of holding its last value.
      if (now > lastBucket) {
        for (let i = lastBucket + 1; i <= now && i - lastBucket <= NBUCKETS; i++) {
          rateBuckets[i % NBUCKETS] = 0;
        }
        lastBucket = now;
      }
      const n = Math.min(NBUCKETS, now + 1);
      const out = [];
      for (let i = n - 1; i >= 0; i--) out.push(rateBuckets[(now - i + NBUCKETS) % NBUCKETS]);
      return out;
    },
  };
}
