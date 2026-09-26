# Owner decisions — 2026-09-25

**The record of what the owner decided, and when.** On 2026-09-25 the owner reviewed the
recommendations for every open question in `2026-09-19-agentistics-runtime-master.md` §50 and in
`2026-09-20-runtime-b3-tool-catalogue.md` (D-T5/6/7) and answered: *"toma as decisões de acordo com
sua recomendação"* — take the decisions according to the recommendation — then *"pode fazer"*.

So every entry below is **decided**, by the owner, on 2026-09-25. Each one carries the reason and the
alternative that was rejected, because a decision with no rejected alternative is a preference and
six months from now nobody can tell which it was. Subtask A1.0 (`s-52b0265e56`) applies this record
to the spec text: it replaces §50's open questions with these answers and removes every hedge in the
spec that these answers settle.

## Blocking A1

**D1 · What is a "Session".** A Session is the runtime's unit of work; a harness conversation is a
**Run** inside it. Legacy data projects 1 Session → 1 Run, so nothing on screen changes until
somebody groups two runs. *Reason:* it is the only option that delivers the brief's objective C — one
session continued across Web, CLI and TUI. *Rejected:* (b) Session stays the conversation with a new
entity above it — inverts the brief's Session → Run hierarchy, and every later document would have to
re-explain it; (c) Task as the only grouping — gives up the shared multi-surface session outright.
*Cost accepted:* "session" means slightly more inside the canonical model than on today's screens;
the docs say so in one place.

**D2 · Journal storage.** **SQLite WAL, one journal per machine.** *Reason:* measured on this machine
(`docs/superpowers/research/15-sqlite-journal-measurement.md`): 1/2/4/8 concurrent writer processes,
zero loss, zero duplication, zero surfaced `SQLITE_BUSY`, 29k → 60k rows/s; idempotency is structural
(`UNIQUE(event_id)`). *Rejected:* (b) JSONL segments + index — idempotency would become code instead
of a constraint; (c) Mongo everywhere — forces a database on every solo install of a local-first
product.

## Before B1 — the native harness

**D3 · Native harness base.** **Our own runtime**, with the provider layer built on the Vercel AI
SDK (Apache-2.0) **behind our own interface**, under the four conditions of master spec §22.1.1
(capture raw per step, read Anthropic's `iterations`, usage per step, own the retry with
`maxRetries: 0`). OpenCode (MIT) is read as architectural reference only; **no code derived from the
leaked Claude Code source, under any option** (§54). *Reason:* the architecture — session, loop,
tools, policy, journal, context manager — is ours; the SDK is only the narrowest layer, the HTTP
dialect of each provider, and it is swappable. *Rejected:* (b) fork OpenCode — inherits their session
and event model, which collides with the canonical journal, and a fast-moving dependency; (c)
everything from scratch including provider clients — five clients to maintain for no telemetry gain.

**API cost and the first provider.** B1 starts with **Anthropic only, on the owner's own API key,
with a spend limit set in the provider console**. Other providers arrive in B5, once the usage model
has been reconciled against one real bill. *Reason:* a subscription cannot be used by our own loop
for Anthropic (master spec §22.3/§22.4); B1's own delivery is recording the exact cost of each call,
so the first thing it proves is that number.

**D4 · Live ingestion.** **Hooks + a local OTLP receiver, with file-tail as the floor.** *Rejected:*
(b) ACP first — spawn-only, and lossy for Gemini's usage today; (c) file-tail only — stays post-hoc.
*Note:* installing a hook into a harness's settings remains an explicit act of the user (CLAUDE.md,
"Anything agentop writes OUTSIDE its own directories").

## Before B3 — the tools

**D-T5 · Sandbox.** **Optional in v1:** `setrlimit` + a capability probe + **Docker as the opt-in
sandbox**; bubblewrap / Landlock via `bun:ffi` / Seatbelt later; native Windows last. The screen
states one of four states in plain words — no sandbox · filesystem only · full container · requested
but unavailable. *Reason:* of five surveyed harnesses only Codex sandboxes by default, and its own
sandbox fails intermittently under WSL; a mandatory sandbox here would be an agent that sometimes
refuses to run. *Accepted by the owner, consciously:* with no sandbox the agent reads anything the
account can read and reaches the network; every write and shell still goes through the policy (D-T3).

**D-T6 · git.** Read verbs as tools in v1 (cheap, and they feed metrics); write verbs as tools in v2.

**D-T7 · Browser.** A gated runtime, reached through delegation — not an ordinary tool.

## Data and privacy

**D5 · Conversation text in the journal.** Metadata + tool summaries by default for external
harnesses. For NATIVE executions the full raw content is stored locally in the content store, under
the context-manager design's §8 rules (never to a central, not in a backup by default, never into
memory without consent, redacted only where it leaves scope, `sensitive` executions excluded from
every exit). *Rejected:* full text for external harnesses — the harness already stores it, and a copy
doubles the sensitive surface.

**D6 · Retention.** **Events are kept forever**, with a size budget and a stated compaction rule.
Raw native content follows the context manager's retention (lives while the session can be resumed,
then expires by age or disk budget; an expired part says so). *Rejected:* a default window with
opt-out — it would delete history nobody asked to delete.

**D7 · Does the central receive events?** **Not in the first phases.** Members keep pushing computed
metrics; an event delta push is phase 4+, behind its own flag, under the same sharing rules.
*Rejected:* an early event push — every privacy rule would need a second implementation.

**D10 · A shared Session in team mode.** **Local-only.** *Rejected:* relayed through a central — a
central-hosted session is a security model this product has never had.

**D14 · Repository memory to a central.** **No, for now** — memory stays on the machine until a need
is stated. *Rejected:* opt-in per repository — memory facts are freer text than task metadata, and
inheriting `Task.shared`'s rule without its own redaction decision is the lenient default by another
door.

**D16 · A central seeing a machine's fleet in real time (issue #215).** **Keep the existing relay and
add a push of state transitions only** — a small, bounded widening, under the same consent switches
and sharing rules. *Rejected:* (b) waiting for D7's event push; (c) leaving it unanswered.

## Before B6 — memory

**D13 · The memory-write consent switch.** Its **own** `preferences.memoryEnabled`, absent reads as
off for inferred writes. *Rejected:* a fourth `archiveMode` value — retaining raw chat and deriving a
durable fact are different questions and deserve different switches.

**D15 · Semantic retrieval in v1.** **No.** Ship structured facts, measure what they answer, add
retrieval deliberately with the reconciliation written down. *Rejected:* retrieval from the start
behind `archiveMode: 'full'`.

## Later

**D8 · Gemini tokens/cost.** Declare the capability **`partial`** and keep the money, with the
reconciliation against a bill written down. **First step, before anything is flipped:** the master
spec says the code already reports `true` while CLAUDE.md says the flags were deliberately left off —
read the code and record which is true. *Rejected:* turning the figures off until a bill is reconciled.

**D9 · Plugin sandboxing.** Define the contract now; ship the loader when there is demand.

**D11 · Provider gateway.** Spec it, build it last — the direct path already produces every number.

**D12 · Browser implementation.** Playwright as the default; the contract stays implementation-
agnostic.

## Also decided on 2026-09-25

- **The native context manager** — every decision is in `2026-09-25-runtime-context-manager-design.md`.
- **Other harnesses as tools of the native loop, and the three engines** — master spec §22.4 and §24.7.
- **Opus in wave A1:** none; every item is Sonnet or Haiku.
- **Issue #248** is closed with a comment pointing at its fix (`versionBump.ts` + its lint).
- **The seven RE-SCOPE issues** from the triage: comments are drafted for the owner's review before
  anything is posted.
- **`PROMPTS NOVO CORE/`**: `Completo.md`, `execucao.md` and the mermaid diagram are committed
  verbatim under `docs/superpowers/briefs/` (the specs cite them; they stay in Portuguese as the
  owner's own text); `findings/` is dropped — it is already in `docs/superpowers/research/`. The loose
  screenshots at the repository root move out of the repository.
