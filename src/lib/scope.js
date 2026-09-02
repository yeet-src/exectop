// Resolving "this application" to something the kernel can filter on.
//
// Three front doors, one primitive. Container and launch are the two that
// matter: both hand us a root pid with no attach race, and everything below it
// is picked up in-kernel at fork. --pid is the general case and carries a race
// we label rather than hide (anything the target forked BEFORE we attached is
// invisible until it forks again).
//
// Field names here are the real ones, checked against the live schema:
// `docker.list_containers` (not `containers`), `inspect_container` takes
// `container_name`, comm lives at `process.stat.comm`, and the cgroup v2 entry
// is the `hierarchy: 0` row of `process.cgroups`.

const V2 = (cgroups) =>
  (cgroups ?? []).find((c) => Number(c.hierarchy) === 0) ?? (cgroups ?? [])[0];

// The cgroup v2 path for a pid — the scope hotspot argues for, since attaching
// per-task races churn and misses anything spawned after you looked.
export async function cgroupPathOf(pid) {
  try {
    const { data } = await yeet.graph.query(
      `{ proc(pid: ${pid}) { cgroups { hierarchy pathname } } }`,
    );
    return V2(data?.proc?.cgroups)?.pathname ?? null;
  } catch {
    return null;
  }
}

// The comm of a pid, for naming a root we never saw exec.
export async function commOf(pid) {
  try {
    const { data } = await yeet.graph.query(`{ proc(pid: ${pid}) { stat { comm } } }`);
    return data?.proc?.stat?.comm ?? null;
  } catch {
    return null;
  }
}

// The root process of a running container: its pid 1, the top of its tree.
// `inspect_container` is authoritative here — `list_containers` returns
// `process: null`, so it can only be used to resolve a name to an id.
export async function containerRoot(nameOrId) {
  const want = String(nameOrId).replace(/^\//, "");
  const { data } = await yeet.graph.query(
    `{ docker { inspect_container(container_name: "${want}") {
        id state
        process { pid stat { comm } cgroups { hierarchy pathname } }
        state_full { pid }
    } } }`,
  );
  const c = data?.docker?.inspect_container;
  if (!c) throw new Error(`no such container: ${want}`);
  const pid = Number(c.process?.pid ?? c.state_full?.pid ?? 0);
  if (!pid) throw new Error(`container ${want} has no running process`);
  return {
    pid,
    comm: c.process?.stat?.comm ?? null,
    cgroup: V2(c.process?.cgroups)?.pathname ?? null,
    label: want,
  };
}

// Every container, for the picker and for a friendlier error than "no such".
export async function listContainers() {
  try {
    const { data } = await yeet.graph.query(
      `{ docker { list_containers { id names state } } }`,
    );
    return (data?.docker?.list_containers ?? []).map((c) => ({
      id: c.id,
      name: (c.names ?? [])[0]?.replace(/^\//, "") ?? c.id?.slice(0, 12),
      state: c.state,
    }));
  } catch {
    return [];
  }
}

// ── seeding a scope that already exists ──────────────────────────────────────
//
// `traced` only ever spread FORWARD, through fork. That is correct for launch
// mode, where the target is parked before it execs and there is no history to
// miss — but for every other front door the interesting processes already
// exist. Attaching to a running app never saw the children it forked before we
// got there, and unscoped mode seeded pid 1 alone, so it caught only processes
// whose entire fork chain postdated attach: a shell started at login was
// invisible, and so was everything typed into it, forever. Duration had nothing
// to do with it; ancestry did.
//
// So: enumerate what is running and seed it, then let fork propagation carry it
// on from there. One graph query, bounded by the process count (a few hundred).

// Every live process as {pid, ppid, comm}. Kernel threads are included — they
// never execve, so they cost a map entry and nothing else.
export async function procTable() {
  const { data } = await yeet.graph.query(`{ procs { stat { pid ppid comm } } }`);
  return (data?.procs ?? [])
    .map((p) => p.stat)
    .filter((s) => s && Number(s.pid))
    .map((s) => ({ pid: Number(s.pid), ppid: Number(s.ppid ?? 0), comm: s.comm ?? null }));
}

// The already-running descendants of `root`, each with its generation distance
// from the root — the same depth the kernel would have assigned had we been
// attached when it forked, so a pre-existing subtree renders at the right
// indent instead of flattening onto the root.
export function descendantsOf(table, root) {
  const kids = new Map();
  for (const s of table) {
    const bucket = kids.get(s.ppid);
    if (bucket) bucket.push(s); else kids.set(s.ppid, [s]);
  }
  const out = [];
  const seen = new Set([root]); // guards against a ppid cycle after pid reuse
  let frontier = [{ pid: root, depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const f of frontier) {
      for (const c of kids.get(f.pid) ?? []) {
        if (seen.has(c.pid)) continue;
        seen.add(c.pid);
        const row = { pid: c.pid, comm: c.comm, depth: f.depth + 1 };
        out.push(row);
        next.push(row);
      }
    }
    frontier = next;
  }
  return out;
}
