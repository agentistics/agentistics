# B3 — The tool catalogue of the native harness

**Track B, step 3 of `2026-09-19-agentistics-runtime-master.md` (§46, §49).** This is where the
product identity is decided: an agent that talks and an agent that ships differ by their tools.

**Status:** specification, ready for an implementation plan. Depends on B1 (provider) and B2
(streaming); B4 (session persistence) may be built beside it.

## 0. Where this comes from

Six sources, all legitimate, none of them the leaked Claude Code source (§50/D3):

| Source | What it gave |
|---|---|
| Claude Code's **public documentation** (36 hook events, tool contracts, permission modes) | `findings/08a` |
| **Measurement of 15 real transcripts** on this machine, 387 MB, 16.197 tool calls | `findings/08b` |
| **Codex CLI** (Apache-2.0, source read) | `findings/10a` |
| **Gemini CLI + Copilot CLI** (docs + `--help`) | `findings/10b` |
| **OpenCode** (MIT, source read) **+ Cline** (Apache-2.0) | `findings/10c` |
| The competitive scan (orchestration products) | `findings/07` |

## 1. The measurements that decide the shape

From this machine's own transcripts — the tail of heaviest use, stated as such:

| Measurement | Consequence for the catalogue |
|---|---|
| **Bash is 76,5 %** of all tool calls (Read 6,0 · Edit 2,8 · Write 0,8) | the shell is THE interface; its contract decides the harness's quality |
| **55,7 % of shell calls are chains**, 76,9 % contain a pipe, 63,3 % a redirect | permission cannot be decided on a command STRING; it needs the structure |
| **46,0 % start with `cd `** | a per-call `cwd` and/or a persistent session, or the model burns a segment on navigation |
| **15,0 % look long-running** (build/test/install/watch/docker) | background execution is not an edge case |
| **MultiEdit: 0 uses** in 587 edits | do not build it |
| **1,67 % of tool-using turns call more than one tool** | optimise the loop for SERIAL calls; parallel is the special case |
| **73 % of sessions compacted**, median at ~48 % of the transcript | context management belongs in v1 |
| **2,72 % of results are errors**, keyword classification explains only 18,9 % | tool results need a STRUCTURED error type, not a regex afterwards |
| **92 interruptions, in 13 of 15 sessions** | interrupt must be cheap and always available |
| sessions: **median 48 human turns, 29,4 h span, p90 ~9 days** | durable, resumable state from day one |

## 2. The four decisions this catalogue forces

### D-T1 · How files are edited — **patch by context (recommended)**

The field is split: Codex uses a grammar-constrained patch located by CONTEXT with no line numbers
and three tiers of tolerance; Claude Code and Gemini use exact string replacement; Copilot ships
both; OpenCode ported Cline's fuzzy diff-apply algorithm (and says so in the file header).

**Recommendation.** A patch tool as the primary editor:

- located by context, **never by line number** — line numbers rot the instant anything above them
  moves, and the model does not reliably know them;
- **tiered matching**: exact → ignoring trailing whitespace → ignoring leading and trailing
  whitespace, and **refuse when no tier matches**, never apply at a guessed offset;
- **rename is a hunk kind**, not a shell `mv` the harness cannot attribute;
- emitted as **grammar-constrained text, not JSON** — it removes a whole class of escaping failure
  from multi-line edits, and this is measurable in the number of retried edits;
- **read-before-write, revalidated against the disk at write time** (Claude Code's rule — staleness
  caught when it matters, rather than at rollback like Copilot);
- plus `write` for a new file and `delete`. **No `MultiEdit`**: zero uses in 587 real edits.

*Borrowing:* the fuzzy-match algorithm is vendored from OpenCode/Cline **with attribution**
(Apache-2.0 for Cline requires a NOTICE entry) rather than re-derived.

### D-T2 · The shell — **one persistent session, four verbs (recommended)**

Codex collapsed run/background/PTY into `exec_command` + `write_stdin` returning a `session_id`.
Copilot exposes four separately-permissioned verbs (`bash`, `read_bash`, `write_bash`, `stop_bash`).
Gemini is one-shot with opt-in PTY. The measurement says the shell carries three quarters of the
work, and 15 % of it is long-running.

**The mechanism is settled, and the repo's own premise was stale.** `sessions/index.ts` states that
"Bun exposes no PTY primitive and a native module cannot live in the single compiled binary" — true
when written, **false now**. Verified locally on 2026-09-20 against the installed **Bun 1.3.14**:

- `Bun.spawn` alone still gives pipes only (`isTTY === undefined` in the child) — the old claim, and
  still the right default;
- **`Bun.Terminal` is first-party and works**: `new Bun.Terminal({cols, rows})` passed to
  `Bun.spawn` yields `isTTY === true`, correct dimensions, a working `.resize()` that propagates
  SIGWINCH, `.write()`, `.setRawMode()` and `.close()` — **and it survives `bun build --compile`**,
  byte-identical;
- `bun:ffi` + `dlopen(libc)` + `openpty()` also works and also survives `--compile` (dlopen resolves
  the system libc at runtime, so the single-binary rule does not bite) — kept as the fallback for a
  Bun older than 1.3.5;
- `node-pty` is moot (and has an unresolved fd-lifecycle bug under Bun).
- Per Bun's own 1.3.14 notes: Linux and macOS since 1.3.5, **Windows via ConPTY since 1.3.14**, with
  stated caveats (no termios control, no echo without a reading child, escapes re-encoded rather
  than byte-identical). **Not verified here** — this box is Linux; vendor-stated only.

**Two consequences beyond this tool.** (a) The sandbox path via FFI (§7/D-T5) is reachable for the
same reason. (b) The product's "no Windows session backend" reasoning needs re-examining — but
**not naively**: `Bun.Terminal` is in-process and exposes no fd or path a second process can join,
so it cannot do what tmux does for the fleet (survive an `agentop server` restart, be attached from
another surface). A Windows backend built on it would be per-process and die with the server. That
is a separate investigation, and the stale comment should be corrected in the code regardless.

**Recommendation.** `shell.start` / `shell.read` / `shell.write` / `shell.stop`, each with its own
permission class, over sessions that persist for the run, on `Bun.Terminal` — **pty opt-in per
call**, plain pipes by default (Gemini's choice, and the right one: most calls do not need a tty):

- a call that does not finish within its yield window **returns a handle, it does not block and does
  not get killed** — Claude Code's own rule ("timeout moves it to the background") and Codex's;
- `cwd` per call, on a session that also keeps its own — the 46 % `cd` prefix is the model routing
  around a missing parameter;
- output is **tiered and truncated with the original size reported**, so the model knows what it did
  not see;
- every call emits `tool.requested` / `tool.completed` carrying a **structured error class**, not a
  string to be regexed later.

### D-T3 · Permission and sandbox — **policy as code, decided on the command's STRUCTURE**

All three CLIs converged on layered policy (Codex: Starlark rules, `forbidden > prompt > allow`,
admin/user/project; Gemini: a TOML policy engine, `admin > user > default`; Claude Code:
`deny → ask → allow` plus protected-path circuit breakers). OpenCode scopes shell permission by
parsing the command into a **tree-sitter AST**.

**Recommendation.**

1. **Rules are data, layered** (machine → user → project), evaluated `deny → ask → allow`, with the
   most specific rule winning and the layer order breaking ties.
2. **A shell command is judged by its parsed structure, segment by segment.** With 55,7 % chains and
   76,9 % pipes, a rule that matches the whole string authorises things nobody read. This repo has
   already paid for the weak version of this lesson (`countGitCommands` had to split chains because
   a wrapper masked 62 commits as 2).
3. **An approval may generalise**: the user approves a prefix (`git pull`), not one invocation —
   Codex's `prefix_rule`. A prompt people meet fifty times a day is a prompt they stop reading.
4. **OS sandboxing is opt-in and real where it exists** (Seatbelt, bubblewrap, container), never
   claimed where it does not. A sandbox that is advertised and absent is worse than none.
5. **Only the pre-tool gate fails closed**; everything else fails open (Copilot's rule) — a broken
   hook must not brick a session, but a permission check that cannot run must not permit.
6. **Every decision is an event** (`policy.requested` / `approved` / `denied`), because "why was
   this allowed" is exactly the question an audit asks six months later.

### D-T4 · Subagent depth — **a hard cap, stated (recommended: 2)**

Gemini caps at 1 ("subagents cannot call other subagents"). Codex has a recursion guard. Copilot's
`/fleet` documents no limit. The measurement found **155 parent-recorded agents against 174
transcripts on disk**, i.e. even the parent's own log under-counts.

**Recommendation.** A depth cap of **2** (an agent may delegate; its delegate may not), a per-agent
token and wall-clock budget, and **the authoritative list is the runtime's own records, never the
parent's tool log** — the rule `subagent-join.ts` already had to learn.

## 3. The catalogue

Permission classes: **auto** (runs without asking under default policy) · **ask** (prompts unless a
rule allows) · **gated** (requires an explicit capability, off by default).

| Tool | v | Purpose | Permission | Events |
|---|---|---|---|---|
| `file.read` | 1 | read a file or a range; images and PDFs by reference | auto | `tool.*` |
| `file.patch` | 1 | context-located patch, add/update/delete/rename | ask | `tool.*` + artifact |
| `file.write` | 1 | create or overwrite a whole file | ask | `tool.*` + artifact |
| `fs.glob` | 1 | find files by pattern, gitignore-aware | auto | `tool.*` |
| `fs.grep` | 1 | search content, bounded results | auto | `tool.*` |
| `shell.start` | 1 | run a command, yield a handle if still running | ask (per parsed segment) | `tool.*`, `policy.*` |
| `shell.read` | 1 | read more output from a running session | auto | `tool.*` |
| `shell.write` | 1 | write stdin to a running session | ask | `tool.*` |
| `shell.stop` | 1 | terminate a session | auto | `tool.*` |
| `git.status` / `git.diff` / `git.log` | 1 | read git without spending a shell call | auto | `tool.*` |
| `git.commit` / `git.branch` / `git.worktree` | 2 | write git as a first-class, attributable act | ask | `tool.*` |
| `task.plan` | 1 | the model's own checklist, at most one step in progress | auto | `alm.*` |
| `ask.user` | 1 | a question with options, answered by a person | auto | `policy.*` |
| `agent.spawn` / `agent.wait` / `agent.stop` | 2 | delegation, depth-capped and budgeted | ask | `agent.*` |
| `mcp.*` | 2 | bridged 1:1, namespaced `mcp__<server>__<tool>` | ask | `mcp.*` |
| `web.fetch` / `web.search` | 2 | read the network | ask | `tool.*` |
| `browser.*` | 3 | navigate, click, type, screenshot, download | gated | `browser.*` |
| `memory.note` | 3 | remember a fact explicitly (§24.6) | ask | `memory.noted` |
| `artifact.attach` | 2 | register evidence against a task criterion | auto | `alm.evidence.attached` |

**Deliberately absent from v1**, each for a measured or stated reason: `MultiEdit` (zero uses); a
semantic code index (none of the five harnesses has one, and the structured tools cover the measured
work); a plan-mode separate from `task.plan`; and any tool whose result the runtime cannot attribute
to an event.

**Tool discovery**: when the catalogue passes a size that costs a real share of the turn, adopt
Codex's `tool_search` — the model asks for tools instead of carrying all of them. Not v1: at this
size it would be ceremony.

## 4. Contracts (the two that matter most)

```ts
interface ShellStart {
  command: string            // may be a chain; it is PARSED, not pattern-matched
  cwd?: string               // defaults to the run's cwd
  tty?: boolean
  yieldMs?: number           // default 10_000; a longer run yields a handle
  maxOutputBytes?: number    // default bounded; the reply states what was cut
}
interface ShellResult {
  sessionId?: string         // present while the process is still alive
  exitCode?: number
  output: string
  outputTruncated: boolean
  originalBytes: number
  wallMs: number
  error?: { class: 'not-found'|'permission'|'timeout'|'killed'|'nonzero'|'internal'; detail?: string }
}

interface FilePatch {
  path: string
  hunks: Array<
    | { kind: 'add'; body: string }
    | { kind: 'delete' }
    | { kind: 'update'; moveTo?: string; context: string[]; lines: Array<{ op: ' '|'+'|'-'; text: string }> }
  >
}
interface FilePatchResult {
  applied: boolean
  matchedTier?: 'exact'|'trailing-ws'|'surrounding-ws'
  linesAdded: number; linesRemoved: number
  error?: { class: 'not-found'|'stale'|'no-match'|'ambiguous'|'permission'; detail?: string }
}
```

Two rules the types encode: **`matchedTier` is reported** (a patch that only matched loosely is a
fact the session should carry), and **an error is a class, not a sentence** — the measurement showed
that classifying afterwards recovers less than a fifth of them.

## 5. Recovery

Three products, three answers: Gemini keeps a shadow git repository; Copilot restores only files it
wrote and skips any the user has since touched; Codex records what the patch tool wrote, outside git.

**Recommendation:** record what the editor itself wrote (path, before, after, event id) — it is
cheap, exact and independent of whether the directory is a repository at all — and **skip any file
changed since**, saying so, which is the honesty Copilot's rule encodes. Worktree isolation stays
the answer for concurrent work; checkpoint is the answer for one agent's own mistakes. State the
non-coverage explicitly, as Claude Code's documentation does: changes made through the shell are
not covered.

## 6. Acceptance criteria

1. Every tool emits `tool.requested` and exactly one terminal event, with a structured error class.
2. A shell command is authorised by its parsed segments; a test fixture of real chained commands
   (taken from the measurement) proves a wrapper cannot smuggle a segment past a rule.
3. A patch that matches no tier is refused, and the refusal names which tier failed.
4. `file.patch` is read-before-write and revalidates at write time; a stale write is refused.
5. Delegation is depth-capped and budgeted, and the authoritative agent list is the runtime's own.
6. Checkpoint restores what the editor wrote and refuses a file changed since, in words.
7. No tool exists whose result cannot be attributed to a `Run` and an `Agent`.
8. The catalogue's v1 set is complete enough to make a real delivery in this repository —
   demonstrated by having the harness do one, end to end, with evidence attached to a task.

## 7. Decisions — the owner's answers of 2026-09-25

All three are recorded in `2026-09-25-owner-decisions.md`; the measurements and trade-offs that were
weighed stay below as history.

- **D-T5 · Sandbox.** **DECIDED 2026-09-25 by the owner:** optional in v1 — `setrlimit` + a capability
  probe + **Docker as the opt-in sandbox**; bubblewrap / Landlock via `bun:ffi` / Seatbelt later;
  native Windows last. The screen states one of four states in plain words — no sandbox · filesystem
  only · full container · requested but unavailable. *Accepted by the owner, consciously:* with no
  sandbox the agent reads anything the account can read and reaches the network; every write and
  shell still goes through the policy (D-T3). **Rejected:** a mandatory sandbox from day
  one — on WSL the sandbox of Codex itself intermittently refuses to run (their issue #1039), so a
  mandatory one here would be an agent that sometimes refuses to run.

  *The question was: sandbox on day one, or after v1? — MEASURED 2026-09-20.*
  Of the five harnesses, **only Codex sandboxes by default** (Landlock + seccomp, bwrap fallback,
  Seatbelt on macOS, restricted tokens on Windows); Gemini and Copilot are opt-in; **OpenCode ships
  none at all** and tells the user to run it in a container themselves. Codex's own combination is
  reported to refuse to run intermittently **under WSL** (their issue #1039) — availability of a
  syscall is not the same as a mechanism you can rely on here.

  Probed on this machine (WSL2, kernel 5.15.167): **Landlock works** (ABI v1 — filesystem only; the
  network hooks need ABI 4 / kernel 6.7+), unprivileged user and mount namespaces work without sudo,
  `seccomp` is compiled in, `bwrap` is absent but every prerequisite for it is present, **Docker
  29.3.0 is fully functional** (an ephemeral `--read-only --network=none --memory=64m` container ran
  successfully), and cgroups v2 is mounted with memory/cpu/pids. `/mnt/c` is a 9p/drvfs mount:
  Landlock, seccomp and namespaces still apply there, but uid- and permission-based containment is
  weaker because those bits are synthesised over NTFS ACLs.

  **The shape decided (v1):** `setrlimit` + a capability probe + **Docker as the opt-in sandbox** —
  all of it subprocess composition, zero native-module cost, compatible with the single binary.
  **Later:** bubblewrap, Landlock through `bun:ffi` (reachable for the same reason the PTY is —
  §D-T2), and a Seatbelt profile. **Last:** native Windows sandboxing, which has no FFI-friendly
  path and cost both Codex and Copilot months of dedicated engineering.

  **And the wording is part of the deliverable.** Four states, four sentences: no sandbox ·
  filesystem-only · full container · requested but unavailable. The honest floor must be said in
  plain words: with no sandbox, the agent reads anything this account can read, reaches the network
  and runs arbitrary code — one under-caught approval is enough, and no malice is required. A green
  shield that is not backed by a mechanism is the confident zero of security.
- **D-T6 · git.** **DECIDED 2026-09-25 by the owner:** read verbs as tools in v1 (cheap, and they
  feed metrics); write verbs as tools in v2. **Rejected:** `git` through the shell only — no attributable git events.
  *The question was: is `git` a tool or the shell?* Every surveyed harness says shell, and this
  product wants attributable git events.
- **D-T7 · Browser.** **DECIDED 2026-09-25 by the owner:** a gated runtime, reached through
  delegation — not an ordinary tool. **Rejected:** the browser as an ordinary tool — reach without a gate. *The
  question was: does the browser belong to the harness or stay a gated runtime?* §25 says its own
  runtime; Gemini's precedent is a bounded, off-by-default browser subagent.
