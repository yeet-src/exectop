# Reusable BPF build rules, included by the project Makefile.
#
# The BPF program is modular: each src/bpf/*.bpf.c is a unit, compiled on
# its own, and all units are statically linked into ONE loadable object,
# bin/probe.bpf.o, with `bpftool gen object` — the same linker libbpf uses
# internally. Split the program across as many .bpf.c files as you like;
# share structs, maps and helpers through headers in src/bpf/include/ and
# the linker merges the duplicates. vmlinux.h (CO-RE) is generated there.
#
# To add another independent object, give it its own link target alongside
# bin/probe.bpf.o below — there is intentionally no per-object magic here.

# CLANG/BPFTOOL are normally resolved by build/toolchain.mk (vendored static
# toolchain or shared cache), included before this file. These are the last
# resort when neither is available: whatever is on PATH. bpftool frequently
# lives in /usr/sbin, which isn't always on a non-root user's PATH; fall back
# to it before giving up.
CLANG   ?= clang
BPFTOOL ?= $(shell command -v bpftool 2>/dev/null || echo /usr/sbin/bpftool)

# Map the host machine to the __TARGET_ARCH_* clang expects.
UNAME_M := $(shell uname -m)
ARCH    := $(UNAME_M:x86_64=x86)
ARCH    := $(ARCH:aarch64=arm64)

# Paths defined on both platforms so `make clean-bpf` (rm-only) behaves the
# same on a Mac. The compile/link rules that consume them live in the Linux
# branch below.
VMLINUX  := src/bpf/include/vmlinux.h
BPF_OUT  := bin/probe.bpf.o

# BPF objects only build on Linux: the vendored toolchain is Linux musl-static
# (toolchain.mk no-ops the cache off-Linux) and there is no macOS bpftool/BTF.
# Without this guard the build falls through to PATH and dies at "bpftool not
# found — install bpftool", advice that can't be followed on a Mac. Fail fast
# with the real fix instead: build inside a Linux VM. (This is a build target,
# not vmlinux/clang, so it also catches `make bundle` etc. early.)
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
bpf:
	@echo "error: BPF objects build on Linux only — macOS has no bpftool or kernel BTF." >&2
	@echo "       Build inside a Linux VM, then run there. With the yeet Lima VM:" >&2
	@echo "         limactl shell yeet.debian-13" >&2
	@echo "         cd <project> && make && sudo yeet run -t ." >&2
	@echo "       (esbuild-only bundle still works here: 'make bundle'.)" >&2
	@exit 1
.PHONY: bpf
else

BPF_SRCS := $(wildcard src/bpf/*.bpf.c)
# One intermediate object per unit. They live under .build/ so they are
# never mistaken for the loadable object in bin/.
BPF_OBJS := $(patsubst src/bpf/%.bpf.c,.build/bpf/%.bpf.o,$(BPF_SRCS))
# The single linked object (BPF_OUT, defined above) is what the JS side loads
# with `import probe from "../bin/probe.bpf.o"` — the loader's BpfObjectRule
# matches on that `.bpf.o` suffix.

BPF_CFLAGS ?= -g -O2 -Wall -target bpf -D__TARGET_ARCH_$(ARCH) -mcpu=v3 -I src/bpf/include
# Add the vendored libbpf program headers (<bpf/bpf_helpers.h>, …) when a
# vendored toolchain supplies them; resolved by build/toolchain.mk. Without
# it, the build falls back to a host libbpf-dev on the default include path.
BPF_CFLAGS += $(if $(BPF_SYSINCLUDE),-I$(BPF_SYSINCLUDE))

bpf: $(BPF_OUT)

# `| toolchain` (order-only) ensures the vendored clang/bpftool are present in
# the cache before any rule shells out to them, without forcing rebuilds.
$(VMLINUX): | toolchain
	@command -v $(BPFTOOL) >/dev/null 2>&1 || { echo "error: bpftool not found — install bpftool / linux-tools"; exit 1; }
	sh build/gen-vmlinux.sh $(BPFTOOL) $@

# Compile each unit to an intermediate object.
.build/bpf/%.bpf.o: src/bpf/%.bpf.c $(VMLINUX) | toolchain
	@command -v $(CLANG) >/dev/null 2>&1 || { echo "error: clang not found — install clang"; exit 1; }
	@mkdir -p $(dir $@)
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@

# Statically link every unit into the single loadable object.
$(BPF_OUT): $(BPF_OBJS) | bin toolchain
	@command -v $(BPFTOOL) >/dev/null 2>&1 || { echo "error: bpftool not found — install bpftool / linux-tools"; exit 1; }
	$(BPFTOOL) gen object $@ $(BPF_OBJS)

# Load the linked object with veristat to confirm THIS kernel's verifier
# accepts every program, and to see per-program complexity (insns/states) — a
# local counterpart to the kernel-matrix CI, which runs the same check across
# many kernels. Loading BPF programs needs privileges, so run with sudo (as
# `yeet run` does). VERISTAT is resolved by build/toolchain.mk (the vendored
# static binary, or `veristat` on PATH).
.PHONY: veristat
veristat: $(BPF_OUT) | toolchain
	@command -v $(VERISTAT) >/dev/null 2>&1 || { echo "error: veristat not found ($(VERISTAT)) — bump build/toolchain.lock to a toolchain that ships veristat, or install veristat on PATH"; exit 1; }
	$(VERISTAT) $(BPF_OUT)

# Run the same verifier check across a matrix of kernels locally (Linux + KVM),
# the local counterpart to .github/workflows/kernel-matrix.yml. Boots
# quay.io/lvh-images/kind images with cilium's lvh + QEMU; pass kernels as
# KERNELS="6.6-main bpf-next-main" or rely on the script's default spread.
.PHONY: veristat-matrix
veristat-matrix: $(BPF_OUT) | toolchain
	VERISTAT="$(VERISTAT)" sh build/kernel-matrix.sh $(KERNELS)

endif  # non-Darwin: real BPF/veristat rules. (Darwin gets the stub `bpf` above.)

# clean-bpf / clangd stay on both platforms: rm/mkdir/printf need no BPF
# toolchain, and clangd editor support is useful while editing .bpf.c on a Mac.
bin:
	mkdir -p bin

clean-bpf:
	rm -rf $(BPF_OUT) .build $(VMLINUX)

# Write a local .clangd so the editor resolves vmlinux.h, the libbpf SDK
# headers and __u* types using the *resolved* toolchain include path — unlike
# the committed .clangd (which only covers in-repo editing), this picks up the
# shared-cache path in a scaffolded project. Run after `make` so vmlinux.h
# exists. The result can hold a machine-specific cache path, so leave it
# untracked. Falls back to host headers when no vendored toolchain is found.
.PHONY: clangd
clangd:
	@printf '%s\n' \
	  '# Generated by `make clangd` — editor flags mirroring build/bpf.mk.' \
	  '# Regenerate after moving machines or bumping the toolchain version.' \
	  'CompileFlags:' \
	  '  Add:' \
	  '    - -target' \
	  '    - bpf' \
	  '    - -Isrc/bpf/include' \
	  $(if $(BPF_SYSINCLUDE),'    - -I$(BPF_SYSINCLUDE)') \
	  '    - -D__TARGET_ARCH_$(ARCH)' \
	  '    - -D__BPF_TRACING__' \
	  > .clangd
	@echo "wrote .clangd (libbpf headers: $(if $(BPF_SYSINCLUDE),$(BPF_SYSINCLUDE),<host include path>))"

.PHONY: bpf clean-bpf
