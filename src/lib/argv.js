// Turning the kernel's raw argv blob into something displayable.
//
// The probe copies `mm->arg_start..arg_end` verbatim: argv entries separated
// by NUL bytes. Splitting is JS's job — the kernel stays dumb, which is what
// kept the verifier quiet.

// Bytes → argv array. Trailing empty entries are dropped (the blob ends with a
// NUL, and a truncated read can leave a partial last entry).
export const splitArgs = (bytes, len, truncated) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = [];
  let cur = [];
  for (let i = 0; i < Math.min(len, view.length); i++) {
    const b = view[i];
    if (b === 0) {
      if (cur.length) out.push(decode(cur));
      cur = [];
    } else cur.push(b);
  }
  // A truncated blob's final entry is incomplete — keep it, marked, rather
  // than silently dropping an argument that might be the interesting one.
  if (cur.length) out.push(decode(cur) + (truncated ? "…" : ""));
  return out;
};

// The isolate has no TextDecoder, so decode by hand. argv is overwhelmingly
// ASCII; anything above 0x7f is passed through as a raw code unit rather than
// UTF-8 decoded, which is enough to keep a path readable and never throws.
const decode = (arr) => {
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return s;
};

// Kernel record → the shape the aggregation layer consumes. Kept here rather
// than in the probe so the aggregation can be exercised without BPF.
export const normalize = (r) => {
  const rec = r.exec_event ?? r;
  const n = (v) => (typeof v === "bigint" ? Number(v) : v);
  return {
    ts: n(rec.ts_ns) / 1e6,
    pid: n(rec.pid),
    ppid: n(rec.ppid),
    comm: String(rec.comm ?? ""),
    argv: splitArgs(rec.args, n(rec.args_len), !!n(rec.truncated)),
    depth: n(rec.depth),
    forkToExecUs: n(rec.fork_to_exec_ns) / 1000,
    truncated: !!n(rec.truncated),
  };
};
