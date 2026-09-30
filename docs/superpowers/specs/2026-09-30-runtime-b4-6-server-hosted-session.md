# Runtime B4.6 — the server hosts a native session (2026-09-30)

**Item:** `s-e50398b96f` on `t-e1dea7cd6f`. **Status:** design, for the leader's decision. No product
code was changed to write it. **Lives in the private repository `agentistics/agentistics-engine`
only** — this is harness (closed) work, and it lands in the ENGINE layout (split spec
`2026-09-29-engine-interface.md`), never in the public tree, except for the small public seams named
in §10.

**Read with:** B4 (`2026-09-27-runtime-b4-sessions.md`, §5 and §8 — the stated limit this item
removes), the harness TUI design (`2026-09-28-harness-tui-design.md`, CD-12 "also open", SS-01), and
the engine interface (§4.4, §4.5, §7, §11).

---

## 0. The problem, as it stands in the code

Measured on `engine/held/feat/harness-tui-p2` (B4 + TUI P1/P2), the most recent layout of these
modules:

- **There is one `RuntimeHost` per PROCESS, and so one hub per process.** `createRuntimeHost()` is
  called by three independent callers: `runtime-sessions-web.ts` (lazily, once per `agentop server`),
  `cli-code.ts` (`defaultHost`, once per `agentop code` in line mode) and `code-host.ts` (once per
  control center, for the `code` tab). Each builds its own `SessionHub`, its own `RunScheduler`
  ceiling, its own journal connection (`openJournal()`) and its own policy map.
- **The hub is in-memory.** `hub.publish` is called synchronously from the runtime's tee journal and
  the `onStreamEvent` hook; nothing crosses a process boundary. A watcher in another process has
  nothing to attach to.
- **Driving is gated by a lease in the shared SQLite store** (`sessions.db`, WAL): one process drives,
  `pid + token`, TTL 60 s refreshed at TTL/3, probed with `kill(pid, 0)`. The lease is the ONLY
  cross-process fact today, and it answers "who may drive", never "where can I watch".

So a session `agentop code` drives in a terminal is invisible to the dashboard, the cockpit's CD-12
"also open" cannot be true, SS-01 (native rows in the fleet) has no source, and a second surface
asking to drive gets `held` with a pid in it. B4 §8 states this as a limit. B4.6 removes it.

---

## 1. Decision: the server is the host; every other process is a client

**One `RuntimeHost` per MACHINE, living in `agentop server`.** `agentop code` and the cockpit's
`code` tab stop building a runtime of their own whenever the local server can host, and become
CLIENTS of it over the same `/api/runtime/sessions*` routes the web already uses — reached through a
local socket (§3), not the TCP port. The server holds every lease, runs every run, owns the only hub
and the only journal connection. A second surface is then exactly what B4 §5 already promised: *an
additional view of the same session, never a second session.*

### Rejected alternatives (and why)

| Alternative | Why not |
|---|---|
| **B. Hub relay to the lease holder.** Each driving process exposes its own hub on a per-process socket named in the lease row; the server proxies watchers to it. | Two kinds of host forever (in-process and relayed), a proxy with its own backpressure between two bounded queues, and the run still dies with the terminal that happened to start it. It solves "watch" and leaves "drive from elsewhere" to a lease hand-off nobody can make safe mid-run. |
| **C. Tail the journal.** Other processes read `session.*`/`tool.*` events from the canonical journal. | The journal carries facts, never content (D5) — no text deltas, no asks. An ask is a live question with a resolver; it cannot be answered through a log. Latency is the journal's flush, not the stream's. |
| **D. Server spawns a child per session.** | A process per conversation is the tmux fleet's shape re-invented; it multiplies memory on a machine that has already OOM-killed `agentop server` once (2026-09-26), and still needs a relay (B) between child and server. |

What A also buys, beyond watching: **one journal writer** (today `cli-code.ts`, `code-host.ts` and the
server each `openJournal()` against the same store), **one ceiling** (`NATIVE_RUN_CEILING` is today
per process, so three processes = 12 runs on a machine sized for 4), and **one admission check**
(`admitSpawn` runs only on the web path today; `agentop code` skips it).

What A costs is stated in §6 (the run's lifetime is now the server's, not the terminal's) and §7
(where a server cannot host).

---

## 2. Topology

```
                     ┌──────────────────────── agentop server (the ONE RuntimeHost) ─────────────────────┐
  browser / VS Code ─┤ TCP :47291/47292  → capability guard → auth gate → Host allowlist → engine routes │
                     │                                                                                   │
  agentop code  ─────┤ unix <dataDir>/run/runtime.sock → capability guard → engine routes (runtime only) │
  cockpit `code` tab ┘                                                                                   │
                     │   store (sessions.db)  content store  journal  hub  scheduler  policies  askers   │
                     └───────────────────────────────────────────────────────────────────────────────────┘
```

- **Reads** are the existing SSE stream (`GET /api/runtime/sessions/:id/stream`, `fromSeq` resume,
  `hello` → sequenced frames, `gap`, `closed`). No new read channel.
- **Writes** are the existing POSTs, consolidated under the one reserved prefix (§4).
- The terminal clients speak the SAME wire as the web. There is no private CLI protocol; a CLI-only
  endpoint would be a second rule set for one session.

---

## 3. The local door — a unix socket, not a token

The terminal must reach the server's runtime routes without a browser session cookie, and must not
make them reachable from anywhere else. The open security finding S-1 (the local server binds
`0.0.0.0` with no auth and no Host check) is exactly why this cannot be "just call localhost".

- **`<dataDir>/run/runtime.sock`**, directory `0700`, socket `0600`, created by the HOST (public
  `index.ts`) at boot when an engine with `provides.nativeRuntime` is loaded, removed on shutdown and
  unlinked-then-rebound at boot (a stale socket from a SIGKILLed server must not refuse the bind).
- **Authentication is the filesystem.** Only the uid that owns `dataDir` can connect. Bun does not
  expose `SO_PEERCRED`; the mode bits are the control, and a test asserts them.
- **The socket serves ONLY the engine's runtime routes** (`/api/runtime/sessions*` and
  `/api/runtime/host`). Not `/api/fleet`, not `/api/data`, not the SPA. A second door to the whole API
  is a second auth model; this one is scoped to the one thing it exists for.
- **The capability guard still runs on it.** A `public` profile denies `localShell`, and the socket
  refuses exactly as TCP does — "never add an opt-in that re-enables host power on `public`" applies
  to a new door too. The terminal then falls back to in-process (§5), which is today's behaviour and
  is the user's own terminal acting as the user.
- **A central binds no socket** (`isCentral()`), and the routes refuse as today.
- **No DNS rebinding, no tailnet peer, no browser** can reach a unix socket. That is the reason it is
  a socket and not a minted token file: a token read by the CLI and sent to `127.0.0.1` is still a
  request to a TCP port S-1 says is exposed.

The HTTP/auth rules for the TCP door are unchanged (authenticated, `localShell`, refused on a
central, admitted by the ceiling + `admitSpawn`).

---

## 4. The wire — what exists, what moves, what is added

All routes live under **`/api/runtime/sessions`**, the one prefix the split reserves
(§10.1 explains why this matters).

| Route | Today (B4) | B4.6 |
|---|---|---|
| `GET /api/runtime/host` | — | **new.** `{ hosted: true, pid, startedAt, runtimeVersion, protocol, runsInFlight, ceiling }`. How a client learns it is talking to a host, and what `agentop restart` reads before bouncing (§6). Same capability as the sessions routes. |
| `POST /api/runtime/sessions` | create | + optional `taskId` / `subtaskId` so filing happens in the host through `host.tasks.fileNative` — the cockpit files BEFORE start today (`fileFailed` refuses the start); that rule moves with it, unchanged |
| `GET /api/runtime/sessions[?before&limit]` | list | unchanged |
| `GET /api/runtime/sessions/:id` | get | + `driver: { kind: 'server' } \| { kind: 'terminal', pid } \| null` — whether the host drives it, or an in-process terminal holds its lease (§5) |
| `GET/POST /api/runtime/sessions/:id/messages` | window / submit | unchanged (first submit takes the lease, repairs, attaches the driver) |
| `GET /api/runtime/sessions/:id/stream` | SSE | `hello` gains `host: { pid, startedAt }` so a client can tell a server restart (new `startedAt`) from a dropped connection and re-open instead of resuming a `fromSeq` that belongs to a ring that no longer exists |
| `POST /api/runtime/tools/:execId/approve` | answer an ask | **moves** to `POST /api/runtime/sessions/:id/asks/:questionId` (the body already carried `sessionId`; the path now does) |
| `POST /api/runtime/runs/:id/cancel` | cancel | **moves** to `POST /api/runtime/sessions/:id/runs/:runId/cancel` |
| `GET /api/runtime/sessions/:id/calls/:toolExecutionId` | — | **new.** `{ target?, diff? }` for an approval card, resolved BY IDENTITY exactly as `code-host.ts` does today (`toolExecutionId` → `listToolCalls` → `toolUseId` → the `tool_use` part). The resolver moves into the host; a missing link still OMITS both fields. |
| `PUT /api/runtime/sessions/:id/mode` | — (in-process `policyOf`) | **new.** `{ profile: 'default' \| 'accept-edits' \| 'plan' }` (B4.7). Switches the session's ONE policy object in the host and journals the switch, so every watcher sees it as an event |
| `GET /api/runtime/sessions/:id/rules`, `DELETE …/rules` | — (in-process) | **new.** List / drop the session approvals ("allow for this session"), the cockpit's CD-15 panel |
| `POST /api/runtime/sessions/:id/finish` | — (in-process) | **new.** `runtime.finish` + hub `close` |

The moves are free: B4 is not on `dev` or `main` (PR #743 was closed), so no published client calls
the old paths. They move once, during the ES.6 replay, and the old paths never exist in the engine.

Every refusal leaves the host as a code plus an already-localized sentence (`host.lang()`), as
`code-host.ts`'s `T` table does today — the table moves into the host and the clients render.

---

## 5. Choosing host or in-process — `planHostChoice` (pure)

A client (`agentop code`, the cockpit tab) decides once, at start:

| Server reachable on the socket, answers `GET /api/runtime/host` | flag | Result |
|---|---|---|
| yes | none | **hosted** |
| yes | `--local` | in-process (today's behaviour), lease taken by this terminal |
| no (absent, stale socket, refused by profile, central) | none | **in-process**, and the start line SAYS so: *"driven by this terminal alone — the dashboard cannot see this session; start `agentop server` to share it."* |
| no | `--hosted` | refused, in words, naming the reason code |

- Reasons are codes (`no-server`, `refused-profile`, `central`, `container`, `api-mismatch`) rendered
  by the client, like `LiveUnavailableReason`. An empty "why" is not allowed.
- **In-process mode is kept**, not deleted: it is what works with no server running, in a pipe, in CI
  (`H16 headless`), and under a `public` profile. Its limit is the old one and it is stated on screen.
- **The two modes meet at the lease.** A session an in-process terminal is driving shows
  `driver: {kind: 'terminal', pid}` to the web; a submit from the web is refused `held` with a
  sentence naming the terminal. The lease holder gains `kind` (`server` | `terminal`) for that
  sentence. There is no automatic hand-off mid-run; when the terminal exits, the lease is released
  and the next submit from anywhere lets the server take it (repair runs first, as today).
- The server never adopts a session a live terminal holds. Taking over a live driver is the one thing
  the lease exists to prevent.

### The facade the two TUI doors are rewritten against

`code-host.ts` and `cli-code.ts` today call `RuntimeHost` members directly (`hub.watch`,
`hub.submit`, `hub.answer`, `acquire`, `policyOf`, `runtime.run/cancel/finish`, `store.listToolCalls`).
B4.6 introduces **`RuntimeFacade`** (engine-internal) — the verbs those two modules actually use —
with two implementations:

- `localFacade(host: RuntimeHost)` — today's calls, unchanged, for in-process mode;
- `remoteFacade(transport)` — the routes of §4 over the socket, SSE parsed back into
  `OutboundFrame`s through the runtime's own `protocol.ts` (`PROTOCOL_VERSION` checked on `hello`;
  a mismatch refuses in words rather than misreading a frame).

Both modules then speak only to the facade, so the cockpit and the line-mode CLI cannot drift into
two behaviours of one session — the rule `createRuntimeHost` already enforces for the web and the CLI.

---

## 6. Lifetime — the run belongs to the server now

This is the product change a person will notice, and it is stated rather than papered over.

- **Closing the terminal DETACHES.** The run continues in the server and is visible in the web and in
  another `agentop code --resume <id>`. Today closing the terminal kills the run.
- **`ctrl+c` CANCELS the current run** (an explicit `…/runs/:runId/cancel`), and says so on the start
  line. A second `ctrl+c` with nothing running leaves. `q` / EOF leave without cancelling.
- **Asks with nobody watching are DENIED** — unchanged HubAsker rule. A run left running after its
  terminal detached, with no dashboard open, proceeds only through what the policy allows without
  asking; every ask it raises is `answered:false`. That is the safe direction and is said on detach:
  *"the run continues; anything it needs to ask will be refused unless someone is watching."*
- **One ask timeout.** The HubAsker's timeout becomes the one the TerminalAsker used (5 min), so a
  question does not expire faster because the terminal became a client.
- **Server stop/restart = runs `lost`, repaired on the next drive** (B4.2, unchanged). `agentop
  restart server` / `restart --all` read `GET /api/runtime/host` first and, with `runsInFlight > 0`,
  ask before bouncing (the control center asks in its detail region like every other question). A
  restart that silently loses N runs is the fleet-killing restart this repo has already been burned by.
- **Hub memory is bounded per session and evicted.** A session's hub entry (ring 512, per-watcher
  queue 256) is dropped when it has no watcher, no driver queue and no run for 10 minutes; a late
  watcher then opens from the store window, as a reconnect past the ring already does. Stated because
  a server that hosts runs is the process that was OOM-killed on 2026-09-26.
- **Ceiling and admission are machine-wide.** `NATIVE_RUN_CEILING` (4) and `admitSpawn` now bind every
  run on the machine, including the terminal's. A fifth concurrent run is QUEUED by the scheduler, and
  the client says "waiting for a free run slot (4 running)" rather than looking hung.

---

## 7. Where a server cannot host

- **Central** — refused, as today; no socket.
- **`public` profile** — the socket refuses (`localShell` denied); the terminal runs in-process.
- **The server runs in a container** (`docker/machine.yml`: harness dirs mounted READ-ONLY, the image's
  own uid). A native tool would edit files inside the container, not the person's workspace. The host
  must say it is containerised; the engine then answers `GET /api/runtime/host` with
  `hosted: false, reason: 'container'` and every `POST /api/runtime/sessions` with that sentence, and
  clients fall back to in-process. This needs a host fact the engine cannot derive itself (§10.2).
- **Tool environment does NOT change.** Tools already run with `MINIMAL_TOOL_ENV` (a fixed PATH and a
  locale, nothing inherited), cwd = the session's, as the same uid (a systemd USER unit). Hosting in
  the server alters none of that — checked, because "the server has a different PATH" was the first
  objection.

---

## 8. Security

- The socket (§3) is the only new door; it widens no route, and the TCP door is unchanged.
- **Audit** (the gap B4 §8 records): `runtime.session.create`, `runtime.session.drive` (first submit /
  lease taken), `runtime.session.mode`, `runtime.session.finish`, each with `transport: 'tcp' | 'unix'`,
  through `host.audit` so the builder's redaction applies. No prompt text in an audit event.
- **Anyone who can watch can drive.** That is B4 §5 as written (a second surface is a view AND may
  submit to the FIFO). It stays; it is now reachable from more places, which is the point. Any
  narrowing ("only the surface that created it may submit") is a product decision — Q-3.
- The ask/answer path is unchanged: first answer wins, a later answer is refused, no watcher = deny.
- Device-side crypto is untouched (C1). Nothing here crosses machines (§11).

---

## 9. What becomes true, by consumer

| Consumer | Before | After B4.6 |
|---|---|---|
| Web watching a terminal-started session | impossible | the same SSE stream; asks answerable from the web |
| Cockpit CD-12 "also open" | cannot be true | `watcherCount` via `GET /api/runtime/host` / `hello` — shown only when true |
| SS-01 native rows in `/api/fleet` | no source | a source exists (the host's session list + `driver`). The fleet rows themselves are a SEPARATE item (§12) |
| H22 VS Code native sessions | no host to talk to | the TCP routes, same as the web |
| ART.3 artifact tools (dep B4.6) | — | the host is where a tool's artifact store lives, once per machine |
| H23 ACP server | — | an ACP adapter becomes one more client of the host |

---

## 10. Seams — public vs engine, and the dependency on the split

**B4.6 depends on split step 3 (ES.3) and on the step-6 replay (ES.6) of B4, B4.7 and TUI P1/P2.**
Every module it rewrites — `runtime-host.ts`, `runtime-sessions-web.ts`, `code-host.ts`, `cli-code.ts`,
`packages/runtime/src/session/*` — moves to the engine at ES.3, and B4 itself exists today only on
`engine/public-archive/feat/runtime-sessions` + `held/*`. Writing B4.6 before ES.6 would be written
against paths that are about to move, on top of code that is not on any mainline. It is implemented in
the engine repo after ES.6, with the small public pieces below landing first as an `engine-api` minor.

### 10.1 A split-spec gap this item found (fix in ES.2/ES.3, independent of B4.6)

`RESERVED_PREFIXES` on `origin/main` (`packages/engine-api/src/engine.ts`) is
`/api/runtime/sessions`, `/api/provider`, `/api/ingest`, `/v1/logs`, `/v1/metrics` — and
`isReservedPrefix` is an EXACT match. B4's routes also live under **`/api/runtime/runs`** and
**`/api/runtime/tools`** (`capability-guard.ts` on the held branch lists all three). Replayed as-is,
the host would refuse those two at load and cancel/approve would 404. Two ways out: (a) reserve both
prefixes (engine-api minor bump), or (b) move both routes under `/api/runtime/sessions` — which B4.6
does anyway (§4). **Recommendation: (b), done during the ES.6 replay of B4**, so the public reserved
list stays as it is and the capability-guard entries for `/api/runtime/runs` and `/api/runtime/tools`
are deleted rather than grown.

### 10.2 Public seams (the only public changes)

| Seam | Change | Kind |
|---|---|---|
| `packages/engine-api` | `EngineRoute.handle(req, url, ctx)` with `ctx: { transport: 'tcp' \| 'unix' }`, and `EngineRoute.localSocket?: boolean` (may this route be served on the socket). `EngineHostServices.container: boolean`. `ENGINE_API_VERSION` 1.x → minor | contract |
| `index.ts` | bind `<dataDir>/run/runtime.sock` when `engine.manifest.provides.nativeRuntime && !isCentral()`; route ONLY `localSocket` engine routes on it, after the capability guard; unlink stale socket at boot and on exit | host |
| `capability-guard.ts` | none new (`/api/runtime/sessions` → `localShell` already); drop `/api/runtime/runs` + `/api/runtime/tools` after §10.1(b); `capability-guard.test.ts` asserts the socket path goes through the guard | guard |
| `cli-start.ts` / `bin/cli.ts` restart | before bouncing the server, ask the engine for runs in flight (`GET /api/runtime/host` over the socket) and confirm when > 0 | host |
| fake engine (`engine/fake-engine.ts`) | covers `ctx.transport`, a `localSocket` route, and refusal of a non-`localSocket` route on the socket | test |
| `docker/machine.yml` path | sets the host's `container` fact (env already distinguishes the image) | host |

### 10.3 Engine seams

| Seam | Change |
|---|---|
| `runtime-host.ts` | stays the ONE builder; now built once per server; lease holder gains `kind`; hub eviction timer; `runsInFlight`; container refusal |
| `runtime-sessions-web.ts` | routes of §4 (moves, new endpoints, `taskId` filing, `driver`, `host` route); declares which are `localSocket`; audit |
| `runtime-facade.ts` (new) | `RuntimeFacade`, `localFacade`, `remoteFacade` (socket transport + SSE → `OutboundFrame`) |
| `plan-host-choice.ts` (new, pure) | §5's table |
| `code-host.ts` | against the facade; the `T` table and the call resolver move to the host; `start` files through the create route |
| `cli-code.ts` | against the facade; `--local` / `--hosted`; `ctrl+c` = cancel; detach sentence; `TerminalAsker` survives only for in-process mode |
| `packages/runtime/src/session/hub.ts` | eviction; `hello.host`; `watcherCount` exposed through the host route |
| `packages/runtime/src/session/sqlite-store.ts` | lease holder `kind` (+ `label`), migration of the lease table |

---

## 11. Non-goals

- **Another MACHINE driving the session** (the board title says "processo/máquina"). A central never
  runs the runtime, and reaching into a machine's sessions from a central is the machine-fleet relay
  with its two consent switches, the row ALLOWLIST and `cwdShared` binding the act half. Native
  sessions joining that relay is its own item, after SS-01, and must satisfy every one of those rules;
  B4.6 builds the machine-local host that relay would sit on.
- Native rows in `/api/fleet` (SS-01) — enabled here, built separately.
- The tmux-hosted harness sessions — untouched; this is the native runtime only.
- A PTY for native sessions — none exists and none is needed; the hub is the screen.

---

## 12. Order of work (after ES.6)

1. **Public, engine-api minor:** `ctx.transport`, `localSocket`, `container`; the socket listener in
   `index.ts`; fake-engine tests. Lands on its own, behind the slot (no engine → no socket).
2. **Engine:** routes consolidated under `/api/runtime/sessions` (§4, incl. §10.1b), `GET …/host`,
   `calls`, `mode`, `rules`, `finish`, lease `kind`, audit, hub eviction.
3. **Engine:** `RuntimeFacade` + `planHostChoice`; `agentop code` hosted mode, `--local`/`--hosted`,
   detach/cancel semantics.
4. **Engine:** the cockpit `code` tab on the facade; CD-12 "also open" made real.
5. **Public:** the restart confirmation reading runs in flight.
6. Separately scheduled: SS-01, H22, the central relay.

## 13. Acceptance

- `agentop code` (hosted) starts a session; a browser on `/api/runtime/sessions/:id/stream` receives
  the same `event`/`delta`/`ask` frames with the same `seq`s; an ask answered in the browser resolves
  the run the terminal started, and the terminal shows `ask-closed`.
- Closing the terminal mid-run: the run completes; `--resume` from a second terminal replays from the
  store window and joins the live edge.
- `kill -9` of the server mid-tool: the next submit repairs (`tool.failed{killed}`, `run.ended{lost}`)
  and every watcher sees the repair.
- An in-process terminal session: the web sees `driver.kind = 'terminal'` and a submit is refused
  `held` naming it; after the terminal exits, a web submit drives it.
- The socket is `0600` in a `0700` dir; a `public` profile refuses on it; a central binds none; a
  containerised server answers `hosted:false, reason:'container'`; a non-`localSocket` route 404s on it.
- Five concurrent runs across two terminals and the web: four run, one reports it is waiting.
- `agentop restart server` with a run in flight asks first.
- No route returns a whole history (B4 §2's window rule, unchanged).

## 14. Open questions

**For the owner (product):**

- **Q-1 — Default when no server is running.** Recommended: in-process with the sentence of §5 (works
  everywhere, today's behaviour). Alternatives: refuse and tell the person to start the server, or
  have `agentop code` start the server itself (a background service appearing because someone typed
  a chat command is the kind of side effect this repo avoids).
- **Q-2 — Closing the terminal detaches instead of killing the run** (§6). Recommended: yes, with the
  detach sentence. The alternative (a terminal close cancels) keeps today's feel and throws away
  "watch it from the web while it runs", which is most of the item.
- **Q-3 — Who may submit.** B4 §5 lets any watcher drive the FIFO. Keep, or restrict submitting to the
  surface that created the session plus explicit "take over"?

**For the leader (technical):**

- **Q-4 — §10.1:** move `runs/*` and `tools/*` under `/api/runtime/sessions` during the ES.6 replay
  (recommended), or reserve two more prefixes in ES.2.
- **Q-5 — The socket vs a minted local token.** Recommended the socket (§3, S-1). A token is simpler on
  Windows, but Windows has no native runtime host here anyway (no tmux, WSL is Linux).
- **Q-6 — Sequencing.** This spec assumes B4.6 waits for ES.6. The engine-api minor (§12 step 1) could
  land in ES.2's tail instead, so the public half is not a separate PR later.
