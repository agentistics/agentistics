/**
 * process-transcript.ts — PURE. Which conversation a codex or kimi process is writing, read off the
 * NAME of a file it holds open.
 *
 * ## Why this exists
 *
 * Neither CLI can be told an id at spawn (`SpawnSpec.assignId` is claude and copilot only; `kimi -S
 * <fresh-uuid>` answers `Session "…" not found`, measured against kimi 0.41.0 on 2026-10-08), and
 * neither writes a record about its own live session the way claude's `~/.claude/sessions/<pid>.json`
 * does. Until this module the only link they had was `task-attribution.ts`'s first-sighting claim,
 * which waits for the DATA rebuild to put the conversation in the store and refuses outright when two
 * rows of one harness share a directory — so `agentop session batch` into one folder left every row
 * unlinked, with no chat and no "delivered" echo (P-17).
 *
 * Both CLIs name the conversation in a PATH they open. The chain `managed row -> tmux pane pid ->
 * the harness process under it -> open fd -> path -> conversation` is exact at every step, and unlike
 * agy's log (`agy-conversation.ts`) nothing has to be read out of the file: the id IS the name.
 *
 * ## What was measured (2026-10-08, this machine)
 *
 * **codex 0.161.0**, started as agentop starts it (`codex --no-daemon`, under tmux). The pane pid is
 * the node shim; the NATIVE binary two levels down (`…/vendor/x86_64-unknown-linux-musl/bin/codex`)
 * is what holds the files. It holds `~/.codex/thread-writer-locks/<thread-id>.lock` from the moment
 * the composer is drawn — BEFORE the first message — and, ~0.9 s after the first message is
 * submitted, `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl` beside it, both
 * held for the life of the process. The two ids were identical, and the rollout's id is the one the
 * codex adapter and `resolveCodexTranscript` key on. So a codex row can be linked before its
 * transcript exists, which is what lets the pending "delivered" echo (keyed by conversation) show up
 * on the very first message.
 *
 * **kimi 0.41.0** (`kimi`, under tmux; the pane pid IS the kimi binary). It creates the session on
 * the first message ("No session yet — one will be created on your first message.") as
 * `~/.kimi-code/sessions/<workspace>/session_<uuid>/` and — measured by sampling `/proc/<pid>/fd`
 * every 5 ms — opens `agents/main/wire.jsonl`, `logs/kimi-code.log`, `state.json.tmp.<pid>.<hex>` and
 * the session directory itself only for the length of each write: 10–300 ms at a time, 176 of 2153
 * samples over a 12 s turn. It does NOT hold them open between events (it does its I/O through
 * io_uring and an append-and-close). So kimi's link is exact WHEN it is seen, and seeing it needs a
 * sampler running while kimi writes — see `holds: 'while-writing'` in `harness-session-file.ts` and
 * the burst sampler in `sessions-host.ts`. Every path under one `session_<uuid>/` names the same
 * conversation, so any of them will do. kimi's id in this product is the bare uuid (`kimi.ts` strips
 * the `session_` prefix), and that is what is returned here.
 *
 * **gemini 0.63.0** and **opencode 1.17.9** were probed the same way and have NO such route: gemini
 * appends to `~/.gemini/tmp/<project>/chats/session-*.jsonl` synchronously (zero hits in 2054 samples
 * at 5 ms across a whole turn), and opencode keeps ONE `opencode.db` for every session, whose name
 * says nothing about which. Recorded in `harness-session-file.ts` beside their `null` entries.
 *
 * ## Read like a private convention
 *
 * Neither path layout is documented. Every function is TOTAL and answers `null` for anything it
 * does not positively recognise, and refuses on ambiguity: two DIFFERENT conversations named by one
 * process's open files is a shape nothing here can resolve (a codex that runs a sub-thread, a kimi
 * mid-`/new`), so it yields no link rather than a guess. An absent link leaves the row exactly as it
 * behaves today; a wrong one puts somebody else's conversation on screen under this row's name.
 */

/** A conversation id as both CLIs write it: a lowercase UUID (codex's are v7, kimi's v4). */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** `…/sessions/2026/10/08/rollout-2026-10-08T23-32-16-<uuid>.jsonl` — the id is the uuid at the END. */
const CODEX_ROLLOUT_RE = new RegExp(String.raw`/sessions/\d{4}/\d{2}/\d{2}/rollout-[^/]*-(${UUID})\.jsonl$`)
/** `…/thread-writer-locks/<uuid>.lock` — codex's per-thread writer lock, held from spawn. */
const CODEX_LOCK_RE = new RegExp(String.raw`/thread-writer-locks/(${UUID})\.lock$`)

/**
 * `…/sessions/<workspace>/session_<uuid>` and anything under it. The workspace segment is kimi's own
 * `wd_<folder>_<hash>`; it is matched as any one segment rather than by that shape, because the
 * `session_<uuid>` directory one level below `sessions/<one segment>/` is the part that is kimi's.
 */
const KIMI_SESSION_RE = new RegExp(String.raw`/sessions/[^/]+/session_(${UUID})(?:/|$)`)

export function codexConversationFromPath(path: string): string | null {
  return CODEX_ROLLOUT_RE.exec(path)?.[1] ?? CODEX_LOCK_RE.exec(path)?.[1] ?? null
}

export function kimiConversationFromPath(path: string): string | null {
  return KIMI_SESSION_RE.exec(path)?.[1] ?? null
}

/**
 * The ONE file among `targets` that names this process's conversation, or `null`.
 *
 * Shared shape for both CLIs: collect every target `fromPath` recognises; exactly one DISTINCT
 * conversation must be named, or there is no answer. When several targets name that one conversation
 * (codex's lock beside its rollout; kimi's wire beside its log), the preferred one is returned — the
 * first `prefer` matches, else the first seen — so the same process yields the same file across
 * polls, which is what the collision guard compares.
 */
function oneConversationFile(
  targets: readonly string[],
  fromPath: (p: string) => string | null,
  prefer: (p: string) => boolean,
): string | null {
  const ids = new Set<string>()
  const files: string[] = []
  for (const t of targets) {
    const id = fromPath(t)
    if (!id) continue
    ids.add(id)
    files.push(t)
  }
  if (ids.size !== 1) return null
  return files.find(prefer) ?? files[0]!
}

/** codex: the rollout when it exists, else the thread lock. Refuses when two threads are named. */
export function codexTranscriptFromFds(targets: readonly string[]): string | null {
  return oneConversationFile(targets, codexConversationFromPath, p => CODEX_ROLLOUT_RE.test(p))
}

/** kimi: the main agent's wire when it is among them, else whichever session path was seen. */
export function kimiTranscriptFromFds(targets: readonly string[]): string | null {
  return oneConversationFile(targets, kimiConversationFromPath, p => p.endsWith('/agents/main/wire.jsonl'))
}

/**
 * Which HOLDERS cannot be trusted, because another holder resolves to the same IDENTITY — the
 * conversation for a path-named harness, the file itself for a content-named one (agy).
 *
 * Keyed by the process that actually holds the file, never by the pid that was asked about: a codex
 * pane is a node shim whose grandchild holds the rollout, and `scanProcesses` reports the shim AND the
 * native binary as two harness processes. Keyed by the asked pid, one codex would collide with
 * itself and never link. Two DIFFERENT holders on one conversation is real ambiguity — two panes
 * running `codex resume <same id>`, or a codex this machine did not start resuming one it did — and
 * neither gets the link, the same rule `agyLogCollisions` applies to agy's shared logs.
 */
export function holderCollisions(
  byHolder: ReadonlyMap<number, string | null>,
): ReadonlySet<number> {
  const holdersByConv = new Map<string, number[]>()
  for (const [holder, conv] of byHolder) {
    if (!conv) continue
    const list = holdersByConv.get(conv)
    if (list) list.push(holder)
    else holdersByConv.set(conv, [holder])
  }
  const out = new Set<number>()
  for (const list of holdersByConv.values()) {
    if (list.length > 1) for (const h of list) out.add(h)
  }
  return out
}
