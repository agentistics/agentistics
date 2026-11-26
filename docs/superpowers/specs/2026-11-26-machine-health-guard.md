# Machine health guard — keep the fleet from taking the disk down, and never lose work if it does

- **Board**: WSL.QUEDA-DISCO, subtask `s-9a79b8bbd0` of `t-e1dea7cd6f`
- **Status**: design (Opus), to be built in slices (Sonnet), docs only — no code in this change
- **Date**: 2026-11-26
- **Owner's words (25/11 ~21:40Z)**: "n quero que isso fique acontecendo"

## 0. What happened, and what this spec is answering

On 2026-11-25 at 09:13:11 BRT the WSL2 root filesystem (ext4 on a `.vhdx` on `C:`) hit an
`IO failure` and was remounted **read-only** (`errors=remount-ro`). Windows logged no disk error.
The kernel journal of that boot (`journalctl -k -b -4`) shows what came before it:

| Fact (measured) | Value |
|---|---|
| WSL memory cap at the time | 12 GB (`MemTotal 12252336 kB`), swap 8 GB |
| Days at the cap | 22/11 → 25/11, swap heavy (151 M pages swapped since 22/11) |
| `page allocation failure: order:7` (`vmbus_alloc_ring`, Hyper-V channels) | **867**, the last one at 09:13:11, the second the disk went read-only |
| Windows disk errors (WHEA) | none (only Wi-Fi and GPU) |

The reading: a Hyper-V channel (the very path the virtual disk's IO travels through) needs a
**physically contiguous 512 KB block** (order 7 = 2^7 pages); a VM that has lived at its memory cap
for days, swapping, has its free memory shattered into small pieces; the allocation fails; an IO
fails with it; ext4 protects itself by going read-only. The disk is fine — the machine around it
ran out of *contiguous* memory.

What filled it is **us**: many assistant sessions, parallel `tsc`/`bun test`, throwaway servers,
and one `node_modules` per worktree, with worktrees and `node_modules` deleted in bulk afterwards.
Today's protection is a set of leader scripts, not product: an hourly autosave cron
(`leader/wip/salvamento-auto.sh`), memory brakes in the leader's rules (≥ 4 GB to open,
< 2,5 GB to pause), a fleet cap of 6.

### The same state, measured again this morning (2026-11-26 ~12:40Z, same WSL boot config)

`/proc/buddyinfo` had **zero free blocks of order ≥ 7** in both the `DMA32` and `Normal` zones:

```
Node 0, zone    DMA32   4241   1173    923    889    537    142      3      0      0      0      0
Node 0, zone   Normal   2849   1911    525    377    209     47      5      0      0      0      0
```

with `MemAvailable` at 4,4 GB — i.e. **the memory meter every brake reads said "fine" while the
precise signal that preceded the crash said "the next order-7 request fails".** That is the central
finding of this spec: `MemAvailable` alone cannot see this failure mode, so the guard's primary
signal is fragmentation (§1.2), with memory, swap rate, disk and kernel errors beside it.

Other facts measured for this spec (read-only, `nice -n19 ionice -c3`):

- `CONFIG_PSI is not set` in the WSL kernel (5.15.167.4-microsoft-standard-WSL2):
  `/proc/pressure/*` does not exist. Any design that leans on PSI is blind on exactly the machine
  that crashed. PSI is used where present, never required.
- `kernel.dmesg_restrict = 0`: an ordinary user can read the kernel ring buffer here, so
  `page allocation failure`, `EXT4-fs error` and `Remounting filesystem read-only` are observable
  without privilege. (Distros that set it to 1 make this signal `unavailable`, said in words.)
- `C:` (the drive holding the `.vhdx`): 930 GB, **130 GB free (87 % used)**. The ext4 inside is a
  1007 GB virtual disk with 201 GB used — so the virtual disk can promise far more than `C:` can
  give it. A dynamically growing `.vhdx` that cannot grow is the other classic route to an IO error
  and read-only remount.
- Swap counters since this boot: `pswpin 18 933 090`, `pswpout 18 088 684` (~72 GB swapped in
  within ~15 h).
- The distro's `LocalState` directory is empty — the `.vhdx` was moved; its real path is in
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss\{guid}\BasePath`, which `reg.exe` from inside
  this WSL did not answer. Slice G1 resolves it through `powershell.exe` and records how.
- `node_modules`: see §3 for the numbers.

## What already exists — reuse, do not duplicate

| Piece | Where | What it does today | Gap this spec fills |
|---|---|---|---|
| `mem-guard.ts` | `packages/server/server/resources/` | `HARD_FLOOR_BYTES` 2 GiB refuses a spawn; `agentop run --rm` waits for 3 GiB (`waitForMemory`) | reads `MemAvailable` only |
| `spawn-admission.ts` | `sessions/` | the ONE gate every spawn path calls (batch, `/api/fleet/new`, cockpit, web) | no fragmentation, disk or kernel-error input |
| `memory-budget.ts` | `sessions/` | meter: how many sessions fit | same |
| `heavy.ts` / `heavy-io.ts` | `resources/` | machine-wide heavy slots, slot 0 = `/tmp/agentistics-heavy.lock`, sized from `MemAvailable` | same |
| `governor.ts` / `governor-daemon.ts` | `resources/` | ticks inventory, kills only provably ownerless processes, alerts on the rest | the place the guard's tick and notices belong |
| `agentop clean` (`clean-plan.ts`, `clean-io.ts`, `clean-web.ts`) | `clean/` | removes merged/clean worktrees, drops stale `node_modules`; scans with `nice`/`ionice` | **applies at full speed**: `git worktree remove` and `rmSync(node_modules, {recursive})` back-to-back, no pause, no priority, no guard check between items |
| engine flows `ciclo-worktrees` / `limpeza` | `agentistics-engine/engine/src/flows/` | DSL cleanup cycles; host op `worktree remove` (`flows/host-ops.ts:249`) | same full-speed removal through the host op |
| `hardware-probe.ts` | server | `statfs` of a path | not wired to any gate |

**Rule for every slice**: extend these, never add a parallel meter. A second "is the machine
OK" answer is a second set of thresholds that will disagree with the first.

---

## 1. The guard — what it reads, what it decides, what it does

### 1.1 Shape

One PURE module, `resources/machine-health.ts`, takes a `HealthSample` and the previous
`HealthState` and returns the new state:

```ts
type Level = 'ok' | 'tight' | 'critical' | 'readonly'
interface HealthState {
  level: Level
  reasons: HealthReason[]            // every signal past its threshold, each with value + threshold
  unavailable: SignalId[]            // signals that could not be read here, said in words
  since: number                      // when this level was entered (hysteresis)
}
```

One IO module, `resources/machine-health-io.ts`, reads the sample (≤ 1 small file read per
signal, no process spawn on Linux except the optional `dmesg` cursor read — see 1.2) and is
ticked by the **governor daemon** that already runs inside `agentop server` (every 10 s; the
governor's own tick). `agentop run --rm`, `agentop heavy` and the spawn gate read the server's
last state through the existing in-process call or, from a separate CLI process, by computing one
sample themselves (the module is cheap and pure; no new endpoint is required for the CLI).

**An unmeasurable signal is `unavailable`, never `ok`** — the N/A-versus-a-confident-0 rule. A
machine where nothing can be measured is admitted (as `spawn-admission.ts` already does) with the
answer saying it was not measured.

### 1.2 Signals and thresholds

All thresholds are constants in `machine-health.ts` with a comment saying where the number came
from; every one carries **hysteresis** (enter at one value, leave at a safer one, and a minimum
dwell) so a value hovering at the line is one notice, not a stream.

| # | Signal | Linux / WSL source | `tight` enters at | `critical` enters at | leaves when | Why |
|---|---|---|---|---|---|---|
| S1 | **Contiguous memory**: free blocks of order ≥ 7, summed over `DMA32` + `Normal` (`DMA` ignored: 16 MB, never used for these allocations) | `/proc/buddyinfo` (world-readable, one read) | sum **< 20** for 2 consecutive ticks | sum **= 0** for 2 consecutive ticks | sum **≥ 40** for 6 consecutive ticks (60 s) | The exact allocation that failed 867 times before the crash; measured at 0 this morning while `MemAvailable` read 4,4 GB. The leader already uses "order 7–10 ≥ 20" as the brake for heavy work (26/11), so `tight` < 20 matches the rule in force. |
| S2 | Kernel said it already failed: `page allocation failure: order:` (any order ≥ 4) | `dmesg` read from a remembered cursor (`--since`/sequence), or `/dev/kmsg` non-blocking | — | **any new line** in the last 10 min | 10 min with no new line AND S1 not critical | A failure that already happened outranks any prediction. |
| S3 | Available memory | `MemAvailable` (`/proc/meminfo`) — never `MemFree` (see `memory-budget.ts`) | **< 4 GiB** | **< 2,5 GiB** | ≥ 4,5 GiB / ≥ 3 GiB | The leader's brakes since 25/11 (open ≥ 4, pause < 2,5), now product. `HARD_FLOOR_BYTES` (2 GiB) stays as the spawn refusal floor beneath them. |
| S4 | Swap-in RATE (not swap used — see `spawn-admission.ts` rule 2: used swap stays "full" long after pressure is gone) | Δ`pswpin` from `/proc/vmstat` over the tick | > **1 000 pages/s** (4 MB/s) averaged over 60 s | > **5 000 pages/s** over 60 s | < 300 pages/s over 120 s | Thrashing is the state that freezes a machine; the 15 h average this boot was ~350 pages/s. **DONO-free tuning**: these two numbers are a first cut; slice G1 logs the signal for a week before G2 acts on it (see risks). |
| S5 | PSI (only where the kernel has it — macOS no, this WSL no) | `/proc/pressure/memory` `some avg60`, `/proc/pressure/io` `full avg60` | memory some ≥ 20 % / io full ≥ 10 % | memory some ≥ 50 % / io full ≥ 30 % | half of entry, 120 s | Best signal where it exists; absent here, so never required. |
| S6 | Host drive free (where the `.vhdx` lives) | WSL: `statfs('/mnt/<drive>')` of the drive in `BasePath`; native: `statfs` of the data dir's filesystem | **< 50 GB** (owner's figure) | **< 20 GB** | ≥ 60 GB / ≥ 25 GB | A `.vhdx` that cannot grow fails IO the same way. `C:` is at 130 GB free today. |
| S7 | Linux root free | `statfs('/')` and of the data dir | < 10 % or < 30 GB | < 5 % or < 10 GB | +5 points | The ext4 inside the vhdx can fill by itself. |
| S8 | Inodes | `statfs` `f_ffree` of `/` | < 10 % | < 3 % | +5 points | Worktrees are ~68 000 entries each (§3); inodes run out before bytes on a fleet of them. |
| S9 | Filesystem went read-only | `/proc/mounts` flags of `/` and of the data dir's mount (`ro`), plus `EXT4-fs error` / `Remounting filesystem read-only` in `dmesg` | — | — | — | Separate level `readonly` (§5): nothing else in this table matters any more. |
| S10 | Dirty/writeback backlog | `Dirty` + `Writeback` in `/proc/meminfo` | > 1 GiB | > 2 GiB | < 512 MiB | A bulk delete or a big `bun install` shows up here first. Used mainly by the throttled cleanup (§2) to pace itself. |

The level is the **worst** of the signals, except that S1 alone never takes the machine past
`critical` and S9 alone decides `readonly`. Every reason carries its value and threshold, so the
notice can say *which* signal and *how far* past the line it is.

#### Other platforms

| Signal | macOS | Windows (native, no WSL) |
|---|---|---|
| S1 fragmentation | not applicable (no buddyinfo, no Hyper-V ring) → `unavailable` | not applicable → `unavailable` |
| S2 kernel failure | not applicable | not applicable |
| S3 memory | `vm_stat` (already `parseVmStat`) + `sysctl kern.memorystatus_vm_pressure_level` (1 normal / 2 warn / 4 critical) mapped to tight/critical | `os.freemem()` + `Get-CimInstance Win32_OperatingSystem` `FreePhysicalMemory` (one PowerShell call per minute, not per tick) |
| S4 swap | `sysctl vm.swapusage` Δ + `vm_stat` `Swapins` Δ | `Get-Counter '\Memory\Pages Input/sec'` (per minute) |
| S6/S7 disk | `statfs` of the data dir | `statfs` of the data dir's drive (Bun supports it on Windows) |
| S9 read-only | `statfs` flags (`MNT_RDONLY`) | not applicable (`unavailable`) |

**From inside WSL the guard also reads the Windows side** — S6 is the one that matters most — and
that read is what Windows-native users don't need: their disk is the disk.

### 1.3 What each level does

The governing rule is the governor's: **never kill, never lose unsaved work; refuse what has not
started, queue what can wait, and say so in plain words with the action attached.**

| Level | New sessions (all spawn paths through `spawn-admission.ts`) | New worktrees (`EnterWorktree`-equivalent paths, flows, `agentop session` with `--worktree`) | Heavy jobs (`agentop heavy`, `agentop run --rm` with a command) | Already running | Cleanup (§2) | Autosave (§4) | Notice |
|---|---|---|---|---|---|---|---|
| `ok` | admitted (existing budget rules) | admitted | admitted (existing slot rules) | untouched | runs | runs on schedule | none |
| `tight` | **refused**, with the reason; `force` overrides loudly (existing `overridden` flag) | refused unless S6/S7/S8 are all ok (a worktree costs disk, not memory) | **queued**: wait in the existing `waitForMemory` loop, now waiting on `level === 'ok'` instead of only `MemAvailable` | untouched | **paused** between items | runs (it is cheap and it is the insurance) | one bell + one Nay card, hysteresis-gated |
| `critical` | refused; `force` refused too unless the caller is a person in the web/cockpit (never an assistant) | refused | queued; **a heavy job the product started itself (an `agentop run --rm` child it holds the PID of) is SIGSTOPped**, not killed, and SIGCONTed when the level drops to `tight` — DONO D1 | sessions untouched (see D1) | stopped | **runs immediately once** (out of schedule) so the newest work is on the other disk before anything worse happens | bell + Nay card + desktop notification (existing cascade) |
| `readonly` | refused | refused | refused | untouched (they cannot write anyway) | stopped | cannot write locally — runs the **push-only** half if the network and the remote allow it (§5) | full-screen notice (§5) |

Plain-words examples (pt-BR default; EN beside it in the catalog). Each names the cause, the effect
and the one action — never "run X":

- tight / S1: *"A memória do Linux está muito fragmentada — é o estado que derrubou o disco em
  25/11. Novas sessões e testes pesados ficam na fila até melhorar. [Ver o que está usando memória]"*
- tight / S6: *"O C: tem só 42 GB livres. Abaixo de 50 GB o agentistics não cria novas cópias de
  trabalho. [Liberar espaço com segurança]"* (opens the clean dialog, §2)
- critical / S2: *"O Linux já falhou ao reservar memória para o disco agora há pouco. Pausei os
  testes que o agentistics iniciou e salvei seu trabalho no C:. Nada foi apagado. [Ver detalhes]
  [Reiniciar o Linux com mais folga]"* (the last button = §6, WSL only)

### 1.4 Where it plugs in

1. `spawn-admission.ts` — gains a `health: HealthState` input; rule order becomes: unmeasurable →
   admitted-and-said; `readonly`/`critical` → refuse; `tight` → refuse (force = loud override);
   then the existing CPU and budget rules. **Every spawn path already calls it** — that is the
   whole reason for putting the rule there.
2. `mem-guard.ts` / `cli-run.ts` `waitForMemory` — waits on `level <= ok` (fallback: the current
   `MemAvailable` test when the guard cannot sample). The message names the signal it is waiting on.
3. `heavy.ts` — `heavySlots()` returns 0 extra slots at `tight` (slot 0 still exists so the queue
   drains when the level recovers), and the waiter treats `critical` as "do not take slot 0 either".
4. Worktree creation — every product path that creates one (`agentop session` worktree option,
   engine flow `ambiente`, `EnterWorktree` hooks we own) calls `mayCreateWorktree(health)`.
5. `governor-daemon.ts` — owns the tick, the SIGSTOP/SIGCONT of the jobs it started (D1), and the
   notices through the existing `broadcastNotification` + Nay notify path
   (`nayNotify.ts`), one per level transition.
6. Web — a **Machine** chip in the existing hardware/health area (`/api/hardware-resources` gains a
   `health` block; no new route), state + reasons + the action; mobile layout in the same change.
7. MCP — `agentistics_env_status` (or the resources tool) returns the same `health` block, so an
   assistant reads "tight because S1" instead of guessing from `free -m` (owner rule: everything has
   MCP).

---

## 2. Throttled cleanup — one at a time, only what is saved, never in bulk

### 2.1 Why the current removal is dangerous

`applyClean` (`clean/clean-io.ts`) and the engine host op (`flows/host-ops.ts:249`) remove a
worktree with `git worktree remove`, which unlinks the whole tree in one burst, and drop
`node_modules` with `rmSync(…, {recursive: true})`, then go straight to the next item. A worktree
here is **~68 000 directory entries** of `node_modules` alone (§3). Ten in a row is ~700 000
unlinks of ext4 metadata journal at full speed, on a VM whose IO path needs contiguous memory —
the bulk-delete trigger named in the incident.

### 2.2 The rule

1. **Eligible only when provably saved**: the existing `clean-plan.ts` facts plus two that must
   both hold for a REMOVE: `pushed` (HEAD contained in `origin/<branch>`, already a fact) AND no
   uncommitted change re-checked immediately before (already `changedSince`). A worktree that is
   merged but **not pushed** is never removed (today `merged` alone is enough — a local merge into a
   local default branch is not a copy anywhere else). `node-modules`-only drops keep today's rule
   (they are regenerable), but go through the same throttle.
2. **One at a time, machine-wide**: a cleanup lock (`/tmp/agentistics-cleanup.lock`, `flock`) held
   by `agentop clean`, the web clean job and the engine host op alike — two cleaners never run at
   once, whoever started them.
3. **Paced unlinking, never one recursive call**: a `throttledRemove(dir)` walks the tree
   depth-first under `nice -n19` + `ionice -c3` (or in-process with `setPriority` + the
   `ioprio_set` equivalent when available) and unlinks in **batches of 2 000 entries, pausing
   250 ms between batches** (≈ 8 000 entries/s ceiling, i.e. ~9 s per worktree's `node_modules`).
   Between batches it re-reads S10 (dirty/writeback) and the guard level: if `Dirty+Writeback >
   1 GiB` it waits for it to drain below 512 MiB; if the level is `tight` or worse it **stops** and
   leaves the half-deleted `node_modules` (harmless: regenerable, and `bun install` repairs it).
   Only once `node_modules` is gone does it call `git worktree remove` (no `--force`) for the
   remaining, small tree — git keeps its own refusal if anything changed.
4. **Rate-limited per hour**: at most **6 worktree removals per hour** and **1 every 2 minutes**,
   whatever the plan lists. A plan of 40 takes ~7 hours in the background and that is the point; the
   UI shows the queue and its ETA.
5. **Never during a heavy job**: a removal does not start while any heavy slot is held.
6. **Mass delete is not a mode**: there is no "remove all now" button and no flag that disables the
   pacing. `agentop clean --yes` keeps its meaning (apply the plan) and is paced like everything else.

Constants live in one pure module (`clean/clean-pace.ts`) so the CLI, the web job and the engine
host op cannot pace differently.

### 2.3 Acceptance

- A throwaway repo with 3 worktrees each holding a synthetic 50 000-file `node_modules`, removal
  under `agentop run --rm`: the log shows ≥ 25 batches with pauses per tree, the lock held, the
  next tree started ≥ 120 s after the previous one (test clock injectable), and an injected `tight`
  level stops mid-tree with the tree intact apart from `node_modules`.
- A merged-but-unpushed worktree is listed as `keep` with the reason in words.
- The engine host op and `agentop clean` both go through `throttledRemove` (grep-lint: no
  `worktree', 'remove'` call outside it; no `rmSync(…recursive` on a worktree path).

---

## 3. Shared `node_modules` — measured first

### 3.1 Numbers (2026-11-26, read-only, `nice -n19 ionice -c3`)

Raw output: `/home/mithrandir/agentistics-workspace/leader/machine-health/medida-node-modules.txt`
(script beside it, `medir-node-modules.sh`). 86 worktrees under `~/agentistics/.worktrees`, 83 with
a `node_modules`.

| Measure | Value |
|---|---|
| One worktree's root `node_modules` (apparent, `du -sk` alone) | ~864 MB, **~68 100 entries** (~7 600 directories); `packages/*/node_modules` add only 3–43 entries each (symlinks) |
| Sum over 83 worktrees, apparent | 69,8 GiB |
| Same 83, **real** (`du` once over all, each hardlinked inode counted once) | **11,7 GiB** |
| `~/.bun/install/cache` | 2,6 GiB (only 0,8 GiB of it is still shared with the worktrees: older installs link to inodes the cache has since dropped) |
| Whole `~/.worktrees` (real) | 24,1 GiB — `node_modules` is ~half of it |
| **Directory entries in the 83 `node_modules`** | **5 630 956** — **78 % of every inode in use on `/`** (7 207 000 of 67 108 864) |
| Distinct `bun.lock` contents among the 86 worktrees | **12** (44 share one, 22 another, the other 10 cover 1–3 trees each) |
| Time to read one tree's entries cold | 1,3 s (`find`), the delete is the same walk plus a journal write per entry |

**Estimate with one store per lockfile (§3.3)**: 12 stores × ~68 000 entries ≈ 0,8 M entries
instead of 5,6 M (**−4,8 M inodes, −86 %**), and each worktree's `node_modules` becomes one
symlink, so creating and deleting a tree stops costing 68 000 metadata writes. Bytes: from 11,7 GiB
real to roughly 12 × 0,15–0,9 GB depending on how much the stores share through the cache — to be
measured by N1, not promised here.

### 3.2 Reading

- **Bun already hardlinks.** Every regular file in a sampled worktree's `node_modules` has a link
  count > 1 (0 files with `links == 1` in `custo-topo`; `react/package.json` has 32 links): the
  default `hardlink` backend links from `~/.bun/install/cache` instead of copying. That is why 69,8
  GiB apparent is 11,7 GiB real. Bytes are a secondary win of sharing, not the main one.
- **What each worktree really costs is ENTRIES.** ~68 000 directory entries (~7 600 directories)
  per tree. Creating them is fast; **deleting them is the bulk metadata write** that §2 has to pace,
  and they eat inodes (S8).
- The workspace links are local: `packages/*/node_modules/@agentistics/*` point *inside* the
  worktree (`../../core`), and the third-party ones point into the root `node_modules/.bun/…` by a
  relative path. Sharing the root `node_modules` therefore does not redirect our own packages to
  another checkout's sources — the trap a naive symlink would have had with a hoisted layout.

### 3.3 Design: one `node_modules` per lockfile, linked into every worktree

1. Store: `~/.agentistics/nm-store/<repo-key>/<sha256(bun.lock)>/node_modules`, created by a normal
   `bun install --frozen-lockfile` in a scratch checkout of that lock under the cleanup lock; marked
   read-only (`chmod -R a-w` is NOT used — a post-install script may need to write; instead the
   store is treated as immutable by convention and verified by a stamp file).
2. A worktree whose `bun.lock` hash has a store gets `node_modules` as a **symlink** to it (one
   entry instead of 68 000). Deleting the worktree unlinks one symlink.
3. A worktree that changes `bun.lock` (adds a dependency) **detaches**: the symlink is replaced by
   a real install for that tree only — never an install *into* the shared store, which other
   worktrees are using at that moment.
4. Store GC: a store no worktree links to for 7 days is removed **through `throttledRemove`**.
5. Cap per repo: at most **N live worktrees per repo** (D3), enforced at creation with the reason
   in words; the cap is what bounds the worst case even if sharing fails.

### 3.4 Risks

- Tools that `realpath` their own location (Vite, Bun's resolver, TypeScript) then see the store
  path, not the worktree. Third-party resolution is unaffected; **our** packages resolve through
  `packages/*/node_modules`, which stay real in the worktree. Slice N1 proves this with the real
  commands (`tsc -b`, `bun test` of one file, `vite build`) in a throwaway before anything ships.
- A post-install script that writes into its own package dir would write into the store and leak
  between worktrees. Mitigation: N1 lists every package with an install script in `bun.lock` and
  tests them; if any writes, that repo stays on per-worktree installs (sharing is per repo, opt-in
  by measurement, never assumed).
- Harnesses that create worktrees themselves (`claude` `EnterWorktree`, codex) do not know about
  the store; the hook is ours (`agentop` worktree creation + a `post-checkout`-free approach: the
  store link is made by the product path that created the tree). Trees made outside the product
  keep their real `node_modules` and are counted, not converted.

---

## 4. Autosave as a product feature

### 4.1 What it does (the cron script's idea, owned by the server)

Every **60 min** (setting; 15/30/60/120) and once immediately when the guard enters `critical`,
for every worktree of every repository the product knows (registry cwds + `git worktree list` of
their repos + the repos listed in Settings):

1. Skip a tree with no uncommitted change and no unpushed commit, and one whose `(HEAD, tree)`
   fingerprint did not change since the last save.
2. Build the save commit **without touching anything the person or the assistant is using**: a
   temporary index (`GIT_INDEX_FILE`), `read-tree HEAD`, `add -u`, untracked files added only when
   < 5 MB and not secret-shaped (the script's `SECRET_RE`, plus `.gitignore` respected), `write-tree`,
   `commit-tree -p HEAD`. No stash, no checkout, no change to the real index, branch or working tree.
3. Store it as `refs/agentistics/autosave/<slug>` (local, hidden from branch lists).
4. **Bundle** `<ref> --not --remotes` into the **off-VM directory** (§4.2), written to a temp name
   and renamed (a crash mid-write never destroys the previous bundle). One bundle per worktree
   (newest) + one daily snapshot kept 7 days.
5. **Push** (when enabled for that repo, D2) to `refs/agentistics/autosave/<machine>/<slug>` with
   `--force` — a non-branch ref, so it does not appear in the GitHub branch list or trigger CI.
   The **public** repository pushes only tracked files (the script's `[rastreados]` commit); the
   bundle keeps everything. If the remote refuses the custom namespace, fall back to
   `refs/heads/autosave/<machine>/<slug>` and say so in the status.
6. Runs under `nice`/`ionice`, one repo at a time, skips the round when `MemAvailable < 1,5 GiB`
   (the script's rule) **except** the out-of-schedule `critical` round, which is the one that
   matters.

Restore is a verb, not a procedure: Settings → Autosave lists each saved tree with its time and
offers **"Recuperar"** (creates a NEW worktree from the bundle or the pushed ref on a new branch
`recuperado/<slug>-<time>`; never overwrites the original).

### 4.2 Where the bundles go

- **WSL**: the Windows user's profile drive, resolved once (`cmd.exe /c echo %USERPROFILE%` →
  `wslpath`), default `<profile>\agentistics-autosave`. This is the whole point: a read-only or
  corrupted ext4 does not take the copy with it.
- **Native Linux / macOS**: default `~/.agentistics/autosave` and the status **says it is on the
  same disk** ("protege contra apagar sem querer, não contra o disco falhar — escolha outra pasta
  ou ative o envio ao GitHub"). A folder picker (`disk-picker.ts` already exists) lets the person
  point it at another disk.
- **Windows native**: `%LOCALAPPDATA%\agentistics\autosave`, same sentence as native Linux.

### 4.3 Setting and status

- `preferences.autosave = { enabled, intervalMin, bundleDir, push: Record<repoKey, boolean> }` —
  machine preference (not a personal UI pref). **Absent reads as ON with push OFF** (D2).
- Web: Settings → **Salvamento automático** (tab beside Backup): on/off, interval, folder, per-repo
  push switch, last round (time, saved, skipped, failed with the reason per tree), and the list
  with "Recuperar". The machine chip (§1.4) shows "salvo há 23 min" and turns amber after
  2 × interval with no successful round.
- MCP: `agentistics_autosave_status` (read) and `agentistics_autosave_run` (one round now).
- CLI: `agentop autosave status|run|restore <slug>`.

### 4.4 Relation to `agentop backup`

Backup carries the **machine's history** (metrics, archive, store); autosave carries **work in
progress in git trees**. Different data, different cadence, different restore — two features, one
settings area. The autosave directory gets an explicit `backup-plan.ts` exclusion row with the
reason "already off the VM disk; carrying it again doubles the backup" (an undecided path fails
`backup-coverage.lint.test.ts`, so the row is required, not optional).

### 4.5 Risks

- Secrets: untracked files are filtered by name and size; tracked files are already in git. The
  public repo never pushes untracked content. A test greps the module for the filter's presence
  (like `backup-plan.test.ts`).
- Cost on a big fleet: today's cron did 178 trees in its first pass. Fingerprint skipping makes
  steady-state rounds cheap; the first round is paced (one repo at a time, nice/ionice).
- The leader's cron keeps running until slice A2 ships and is verified; then the leader removes the
  cron (not the product).

---

## 5. "The filesystem went read-only" — detection and recovery

### 5.1 Detection

S9: `/proc/mounts` shows `ro` on `/` or on the data dir's mount, or `dmesg` shows `EXT4-fs error`
/ `Remounting filesystem read-only`. Polled by the guard tick; also caught reactively: any write
by the server that fails with `EROFS` flips the level immediately (one shared `onWriteError`
helper in the store writers — the server must not loop retrying writes that cannot succeed).

### 5.2 What the server does

- Stops every write path (store, registry heartbeat, journal, logs to disk) and keeps serving from
  memory — the web bundle is embedded, so the dashboard still opens.
- Tries the **push-only** autosave round (§4) once: git objects cannot be written locally, but the
  last autosave refs already in the repo can still be pushed if the network is up. Says the result.
- Shows a full-screen notice in the web, the cockpit and the VS Code extension (and a Nay card),
  in plain words:

> **O disco do Linux entrou em modo de proteção (somente leitura).** Isso acontece quando o Linux
> fica sem memória contínua ou o disco do Windows enche. O disco não quebrou. Seu trabalho até
> **14:07** está salvo em `C:\Users\…\agentistics-autosave` (e no GitHub, nos repositórios com
> envio ligado). **Para consertar:** [Preparar o reparo] — isso coloca um arquivo de reparo na sua
> Área de Trabalho e abre a pasta; feche os programas, dê dois cliques nele e siga as instruções.
> Depois, abra o agentistics de novo: ele confere o disco e reabre suas sessões.

- **[Preparar o reparo]** (WSL only) writes `Reparar-Linux.cmd` to the Windows Desktop (the
  `RODAR-REPARO-WSL.cmd` the leader wrote by hand on 25/11, made a template: `wsl --shutdown`, then
  `wsl -d <distro> -u root -e e2fsck -fy /dev/sdX`… — the exact command recorded by slice R1 after
  being run once on a throwaway distro, never guessed) and opens Explorer on it through interop.
  The product **never runs it by itself**: it shuts the whole Linux down, the product included (D4).
- After the next boot, the guard reads `dmesg` for `mounting fs with errors` and, if present, keeps
  the notice up ("o reparo ainda não foi feito") and refuses heavy work until it clears.

### 5.3 Acceptance

A throwaway loop-mounted ext4 image (`mkfs.ext4` on a file, `mount -o loop`, then `mount -o
remount,ro`) needs root — so R1's automated tests feed the pure detector with `/proc/mounts`
fixtures and `EROFS` errors, and the end-to-end check is a **manual** run documented in the
slice's QA report on a disposable WSL distro (`wsl --import` of a tiny rootfs), never on the
owner's distro.

---

## 6. WSL specifics — advice the app can act on

### 6.1 What the app checks (read-only)

- The effective memory/swap (`/proc/meminfo`), `vm.swappiness`, `vm.min_free_kbytes` against the
  `.wslconfig` the person has (`%USERPROFILE%\.wslconfig`, read through `/mnt/c`).
- Whether the running kernel reflects the file (e.g. today: file says 16 GB + swappiness 10, the
  running VM has 12 GB + swappiness 60 → "a configuração nova só vale depois de reiniciar o Linux").
- The `.vhdx` path and size (BasePath, §0) against the drive's free space.

### 6.2 What it recommends, and the numbers

| Setting | Recommendation | Why |
|---|---|---|
| `memory` | `min(total RAM − 6 GB, 0,75 × total RAM)`, rounded down to a GB | leaves Windows room; at 32 GB → 24 GB, at 24 GB → 18 GB. The current 16 GB is inside this rule on a machine with ≥ 22 GB |
| `swap` | 8 GB (keep) | swap is a cushion; the problem was living in it, which the guard now prevents |
| `kernelCommandLine` | `sysctl.vm.min_free_kbytes=262144 sysctl.vm.swappiness=10` | keeps a 256 MB reserve the kernel can compact contiguous blocks from; swaps later |
| `[experimental] autoMemoryReclaim` | `gradual` (keep) | returns cache to Windows slowly |
| `[experimental] sparseVhd` | `true` (keep) + offer a **compaction** when the vhdx is ≥ 1,5 × the used size | the vhdx only grows unless compacted |

### 6.3 How it is offered (never "run X")

A card in the Machine area: *"O Linux pode usar até 12 GB e já passou dias no limite. Recomendo
16 GB e uma reserva de memória para o disco. [Aplicar e reiniciar o Linux depois]"*. The button:

1. backs up `.wslconfig` to `.wslconfig.antes-<date>` (the leader's manual step, made product),
2. writes the merged file (keys it does not own are preserved — same merge discipline as
   `claude-hooks.ts`: refuse a file it cannot parse rather than rewrite it),
3. **does not restart WSL**: it says "vale no próximo reinício do Linux" and offers
   [Reiniciar agora] only when autosave has a fresh round (< 5 min) and no session is `working` —
   the restart kills every session and the product itself (D4).

### 6.4 macOS / Linux native / Windows native

No equivalent knobs worth offering; the card is absent there (not greyed).

---

## 7. Slices

Sizes are AI-paced hours of implementation + QA. "Repo" says where the code lands; the engine owns
anything that touches a harness (spawn, worktree creation inside flows, the flows' host ops).

| # | Slice | Repo | Size | Depends on | Acceptance check |
|---|---|---|---|---|---|
| **G1** | `machine-health.ts` (pure) + `-io.ts`: signals S1–S10 on Linux/WSL, `unavailable` elsewhere; the governor tick records samples to `~/.agentistics/health/samples.jsonl` (rotated, 7 days); `/api/hardware-resources` gains the `health` block; **observe only, no gate yet** | public host | 4 h | — | unit tests with buddyinfo/meminfo/vmstat/mounts/dmesg fixtures (incl. this morning's buddyinfo → `critical`); hysteresis tests (hover at 19/21 = one transition); `unavailable` on darwin/win fixtures; a throwaway server shows the block |
| **G2** | Gates: `spawn-admission.ts`, `waitForMemory`, `heavy.ts`, worktree creation (host paths) read the level; notices via governor + Nay; web Machine chip (desktop + mobile) + MCP field | public host | 5 h | G1 + one week of G1 samples to confirm S4 thresholds (can ship with S4 observe-only) | each spawn path refused at `tight` with the sentence (batch, `/api/fleet/new`, cockpit, web); `force` loud; `agentop run --rm` waits on the level and says which signal; screenshot 1440/390 |
| **G3** | Engine side: flows' worktree creation and host ops consult the level; SIGSTOP/SIGCONT of product-started heavy children (if D1 = yes) | engine + host op seam | 3 h | G2 | engine flow test: `ambiente` refuses at `tight`; a fake child is stopped at `critical` and continued at `tight`, never killed |
| **C1** | `clean-pace.ts` + `throttledRemove` + cleanup lock; `applyClean` uses it; `pushed` required for REMOVE | public host | 4 h | G1 (reads S10 + level) | §2.3 |
| **C2** | Engine `ciclo-worktrees`/host op `worktree remove` go through the same `throttledRemove` (via the host op, so the pacing lives once) | engine + host op | 2 h | C1 | grep-lint; flow dry-run on a throwaway repo shows the paced removal; never `AGENTISTICS_FLOWS=1` against real paths |
| **A1** | Autosave engine: pure planner (which trees, fingerprint, secret filter) + IO (temp index, commit-tree, hidden ref, bundle to the off-VM dir, retention) | public host | 5 h | — | tests on throwaway repos: dirty + untracked + secret-named file + 6 MB file → bundle holds the right set, real index/branch/working tree byte-identical before/after; crash mid-bundle keeps the previous bundle |
| **A2** | Push half (hidden ref, public = tracked only, fallback namespace) + settings + web tab (desktop + mobile) + MCP + CLI + "Recuperar" | public host | 5 h | A1, D2 | push verified against a throwaway GitHub repo of the owner's org (or a local bare remote if no throwaway repo is authorised); restore creates a new worktree, original untouched; leader retires the cron after a day of matching logs |
| **R1** | Read-only detection + `EROFS` short-circuit in writers + full-screen notice (web/cockpit/VS Code/Nay) + "Preparar o reparo" template | public host | 4 h | G1, A1 | fixture tests; `EROFS` injected in a writer stops retries; manual end-to-end on a disposable WSL distro, documented |
| **W1** | WSL card: read `.wslconfig`, compare with running values, recommend, write with backup + merge, never restart by itself; vhdx BasePath + size via `powershell.exe` | public host | 3 h | G1 | merge tests (unknown keys and comments preserved; unparsable file refused); on this machine it reports "12 GB running, 16 GB configured, restart pending" |
| **N1** | Measure + prove the shared store on a throwaway: `tsc -b`, one `bun test`, `vite build` from a symlinked `node_modules`; list install scripts | public host (study, no product code) | 2 h | — | report with the commands' exit codes and times, under the heavy lock, one job at a time |
| **N2** | Store + link at product worktree creation + detach on lock change + GC through `throttledRemove` + per-repo worktree cap | engine (worktree creation is a flow/harness path) + host seam | 5 h | N1 green, C1, D3 | creating a worktree adds 1 entry, not ~68 000; changing `bun.lock` detaches only that tree; store GC paced |

**Order**: G1 → (A1 ∥ C1) → G2 → R1 → A2 → C2 → G3 → W1 → N1 → N2.
Autosave and paced cleanup come before the gates because they are what stop *losing work* and
*triggering* the failure; the gates only stop *approaching* it, and G1's week of samples is what
makes their thresholds trustworthy.

### Cross-cutting risks

- **A guard that cries wolf gets switched off.** S1's thresholds come from this machine's two
  measurements (crash day: 867 failures; this morning: 0 blocks at 4,4 GB available). G1 logs a
  week before G2 enforces; any threshold G1's log shows firing more than ~3 times a day without a
  real problem is retuned before G2, and the tuning is written in the constant's comment.
- **Compaction can fix S1 on its own.** The kernel compacts on demand; a value of 0 may recover
  in seconds. Hence the 2-tick entry and the 60 s exit. The guard may also *ask* for compaction
  (`/proc/sys/vm/compact_memory` needs root — not available; recorded as a limit, not worked around).
- **Refusing sessions during a long `tight` stalls the fleet.** That is the intended trade (the
  alternative was a dead disk), but the notice must name what to close, and the queue must drain by
  itself when the level drops — no manual "resume".
- **Interop calls (`powershell.exe`, `cmd.exe`) are slow** (hundreds of ms) and can hang: always
  with a timeout, at most once per minute, never on the 10 s tick.
- **Tests never touch the real machine state**: everything above runs under `agentop run --rm`,
  throwaway repos under `/tmp`, `env -u AGENTISTICS_FLOWS`, never against `~/.agentistics` or the
  owner's distro.

## 8. Owner decisions (DONO)

- **DONO D1 — may the product pause (SIGSTOP) a heavy job it started itself when the machine is
  `critical`?** Recommendation: **yes, only children of `agentop run --rm`/`agentop heavy` whose
  PID the product holds**, resumed automatically at `tight`; never an assistant session, never a
  process it did not start. A paused `bun test` loses nothing; a dead disk loses everything.
- **DONO D2 — autosave defaults.** Recommendation: **on by default, bundle to the Windows disk on
  WSL; push OFF by default, switched on per repository** (pushing is an outward act and the
  public repo must never receive untracked files). For this machine: push on for the agentistics
  org repos, matching the cron.
- **DONO D3 — worktree cap per repository.** Recommendation: **12 live worktrees per repo**
  (today `~/agentistics/.worktrees` holds 86), with older clean ones offered to the paced cleanup
  when the cap is reached; refuse creation past it with the reason.
- **DONO D4 — may the app restart WSL or run the disk repair itself?** Recommendation: **no** —
  it prepares the file / the config and asks the person to act, because both kill every session and
  the app itself; it offers [Reiniciar agora] only with a fresh autosave and no `working` session.
- **DONO D5 — C: threshold.** The brief says 50 GB; recommendation: keep **50 GB tight / 20 GB
  critical**, and on drives under 256 GB use 20 % / 8 % instead (50 GB is most of a small drive).
