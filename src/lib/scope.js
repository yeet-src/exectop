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
