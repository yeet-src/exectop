// The BPF object: loaded once, shared by every probe module.
//
// `traced` is seeded from JS (the root pid) and then maintained in-kernel by
// the fork/exit tracepoints. `probe.bss` carries the cgroup id when we scope
// to a container — see scope.js for how the target is resolved.
import { BpfObject } from "yeet:bpf";

// Bundled, this module sits at src/ so the object is one level up. Run
// standalone (the import.meta.main self-tests) it sits at src/probes/, so
// try that path too rather than making the self-test a special case.
const CANDIDATES = ["../bin/probe.bpf.o", "../../bin/probe.bpf.o"];

async function load() {
  let last;
  for (const exe of CANDIDATES) {
    try {
      return await new BpfObject({ exe, base: import.meta.dirname })
        .bind("events", { kind: "ringbuf", btf_struct: "exec_event" })
        .bind("traced", { kind: "hash" })
        .bind("fork_ts", { kind: "hash" })
        .bind("stats_map", { kind: "array" })
        .bind("probe.bss", { kind: "data" })
        .start();
    } catch (err) { last = err; }
  }
  throw last;
}

export const control = await load(); // the three sched tracepoints auto-attach
