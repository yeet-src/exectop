// exectop — every process a target application launches.
//
// Three hooks maintain one idea: a set of tgids that belong to the traced
// application, and a stream of the execs they perform.
//
//   sched_process_fork  → a traced task's child joins the set
//   sched_process_exec  → if the task is in the set, emit the exec
//   sched_process_exit  → the task leaves the set
//
// The fork/exit membership pattern is lifted from agent-lock and omp-jail,
// where it already carries a jail's identity across a process tree. Here it
// carries *scope*: without it, "this application" would mean one pid, and the
// first thing a build system does is fork.
//
// Scoping is by cgroup when we can resolve one, falling back to a pid seed.
// hotspot makes the argument: attaching per-task races churn and misses
// anything spawned after you looked, which for an exec tracer is most of it.
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

char LICENSE[] SEC("license") = "Dual BSD/GPL";

#define ARGV_BUF   1024 // total bytes of argv we carry per exec
#define ARGV_MAX     24 // how many argv slots we try to read
#define COMM_LEN     16

// One exec. `args` is a flat NUL-separated blob — the kernel copies raw bytes
// and JS splits them. Parsing argv in C would mean bounded string scans the
// verifier fights us on for no gain; the dev-loop rule is copy raw, parse up.
struct exec_event {
	__u64 ts_ns;
	__u64 fork_to_exec_ns; // time between the fork and this exec (0 if unknown)
	__u32 pid;
	__u32 ppid;
	__u32 argc;         // how many argv entries the kernel reported
	__u32 args_len;     // bytes used in args[]
	__u32 depth;        // generations below the traced root
	__u8  truncated;    // argv didn't fit in ARGV_MAX slots or ARGV_BUF bytes
	__u8  _pad[3];
	char  comm[COMM_LEN];
	// __u8, NOT char: yeet decodes a char[] as a C string and stops at the
	// first NUL, which for a NUL-separated argv blob means you only ever see
	// argv[0]. As a byte array it arrives intact and JS does the splitting.
	__u8  args[ARGV_BUF];
};


struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	// 32 MiB. A record is ~1 KiB (the argv window dominates), so 4 MiB held
	// only ~4000 events and a parallel fork storm outran it in under a second:
	// measured 7k of 36k execs arriving, the rest dropped silently. This is
	// the cheapest lever, and the drop counter above reports what still slips
	// through rather than letting a burst quietly truncate the picture.
	__uint(max_entries, 1 << 25);
} events SEC(".maps");

// The traced set: tgid -> depth below the root. Seeded from userspace with the
// root pid, then propagated at fork. Depth is carried so the UI can show how
// far from the root a process is without reconstructing the tree in kernel.
//
// Key and value are named structs, not bare __u32: the JS map API serializes
// through BTF, and a scalar-typed map has no struct to name, so writes from
// userspace are silently dropped. Wrapping them makes the seed actually land.
struct traced_key {
	__u32 tgid;
};

struct traced_val {
	__u32 depth;
};

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 16384);
	__type(key, struct traced_key);
	__type(value, struct traced_val);
} traced SEC(".maps");

// pid -> fork timestamp, so exec can report fork→exec latency. Separate from
// `traced` because it's keyed per-task and dropped as soon as it's consumed.
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 16384);
	__type(key, __u32);
	__type(value, __u64);
} fork_ts SEC(".maps");

// Event counters, read by JS. `emitted` and `dropped` are the two numbers that
// matter: a burst that outruns the ring buffer loses execs, and losing them
// silently is worse than the loss. Measured on a 12-way fork storm, 36k execs
// in a few seconds, only ~7k arrived — 80% gone with nothing on screen to say
// so. The UI now shows a dropped count when it is non-zero.
struct counters {
	__u64 emitted;
	__u64 dropped;
};

struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct counters);
} stats_map SEC(".maps");

// Set from JS before the subscription opens (probe.bss). When non-zero, only
// tasks in this cgroup are eligible — the cgroup is the scope and `traced`
// narrows it to the actual subtree. When zero, `traced` alone decides.
volatile __u64 target_cgid = 0;

// Scratch for building the event. An exec_event is ~1 KiB, far past the 512 B
// BPF stack limit, so it lives in a per-CPU array — the standard workaround.
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct exec_event);
} scratch SEC(".maps");

static __always_inline int in_scope(__u32 tgid, __u32 *depth_out)
{
	struct traced_key k = { .tgid = tgid };
	struct traced_val *d = bpf_map_lookup_elem(&traced, &k);
	if (!d)
		return 0;
	// target_cgid is inert: the traced tgid set is the scope, seeded from the
	// process graph and grown at fork. Kept as a knob for a future
	// cgroup-only mode, and it reads as 0 unless something patches it.
	if (target_cgid && bpf_get_current_cgroup_id() != target_cgid)
		return 0;
	*depth_out = d->depth;
	return 1;
}

// A traced task forked: the child inherits membership one generation deeper.
SEC("tracepoint/sched/sched_process_fork")
int on_fork(struct trace_event_raw_sched_process_fork *ctx)
{
	// The parent key is its TGID, not ctx->parent_pid. The tracepoint reports
	// *tids*, but `traced` is keyed by tgid on the read path (in_scope uses
	// pid_tgid >> 32), so looking the parent up by tid only matched when the
	// forking thread happened to be created after we seeded — a thread that
	// already existed at attach was never in the map, and every process it
	// spawned, and that subtree's entire exec stream, was invisible. The fork
	// tracepoint runs in the parent's context, so pid_tgid gives us the tgid.
	// (Thread creations still insert a tid-keyed entry here. It is never read,
	// since lookups are by tgid, and it is dropped at that thread's exit.)
	__u32 parent = (__u32)(bpf_get_current_pid_tgid() >> 32);
	__u32 child = (__u32)ctx->child_pid;

	struct traced_key pk = { .tgid = parent };
	struct traced_val *pd = bpf_map_lookup_elem(&traced, &pk);
	if (!pd)
		return 0;

	struct traced_key ck = { .tgid = child };
	struct traced_val cd = { .depth = pd->depth + 1 };
	bpf_map_update_elem(&traced, &ck, &cd, BPF_ANY);

	__u64 now = bpf_ktime_get_ns();
	bpf_map_update_elem(&fork_ts, &child, &now, BPF_ANY);
	return 0;
}

SEC("tracepoint/sched/sched_process_exit")
int on_exit(struct trace_event_raw_sched_process_template *ctx)
{
	__u32 pid = (__u32)ctx->pid;
	struct traced_key k = { .tgid = pid };
	bpf_map_delete_elem(&traced, &k);
	bpf_map_delete_elem(&fork_ts, &pid);
	return 0;
}

// The main event. `bprm` carries the argv we want, but it lives in userspace
// memory, so every read is a bpf_probe_read_user_str and every one can fail.
SEC("tracepoint/sched/sched_process_exec")
int on_exec(struct trace_event_raw_sched_process_exec *ctx)
{
	__u64 id = bpf_get_current_pid_tgid();
	__u32 pid = id >> 32;
	__u32 depth = 0;

	if (!in_scope(pid, &depth))
		return 0;

	__u32 zero = 0;
	struct exec_event *e = bpf_map_lookup_elem(&scratch, &zero);
	if (!e)
		return 0;

	e->ts_ns = bpf_ktime_get_ns();
	e->pid = pid;
	e->depth = depth;
	e->argc = 0;
	e->args_len = 0;
	e->truncated = 0;

	__u64 *ft = bpf_map_lookup_elem(&fork_ts, &pid);
	e->fork_to_exec_ns = ft ? e->ts_ns - *ft : 0;
	if (ft)
		bpf_map_delete_elem(&fork_ts, &pid);

	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	e->ppid = BPF_CORE_READ(task, real_parent, tgid);
	bpf_get_current_comm(&e->comm, sizeof(e->comm));

	// argv lives at mm->arg_start..arg_end as a NUL-separated blob already —
	// no pointer-array walk needed, which keeps the verifier happy. We copy a
	// bounded window of it and let JS split on NUL.
	unsigned long arg_start = BPF_CORE_READ(task, mm, arg_start);
	unsigned long arg_end = BPF_CORE_READ(task, mm, arg_end);
	unsigned long len = arg_end - arg_start;

	if (len > ARGV_BUF) {
		len = ARGV_BUF;
		e->truncated = 1;
	}
	// Bound for the verifier: len is unsigned and now provably <= ARGV_BUF.
	if (len > 0 && len <= ARGV_BUF) {
		long n = bpf_probe_read_user(&e->args, len, (void *)arg_start);
		e->args_len = (n == 0) ? (__u32)len : 0;
	}

	// A variable-length emit (HDR_BYTES + args_len) was tried here to raise
	// throughput, since the ring is bound by bytes moved and the median argv
	// blob is only 48 bytes against a 1024-byte field. It does not work: the
	// ring buffer is bound on the JS side with `btf_struct: "exec_event"`, so
	// the consumer decodes fixed-size records and a short write delivers
	// nothing at all (measured: 0 events received). Raising the ceiling would
	// mean a smaller ARGV_BUF, which truncates 12% of real records, or a
	// second smaller event type. Left as a documented limit instead: the
	// drop counter reports what is lost rather than hiding it.
	long sent = bpf_ringbuf_output(&events, e, sizeof(*e), 0);
	struct counters *c = bpf_map_lookup_elem(&stats_map, &zero);
	if (c) {
		if (sent < 0)
			__sync_fetch_and_add(&c->dropped, 1);
		else
			__sync_fetch_and_add(&c->emitted, 1);
	}
	return 0;
}
