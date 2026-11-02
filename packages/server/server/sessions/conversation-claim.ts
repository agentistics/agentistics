/**
 * conversation-claim.ts — PURE. Which conversations are being driven RIGHT NOW, and by what.
 *
 * This exists because of the worst thing the session manager has done: it opened the SAME
 * CONVERSATION in two terminals at once. Measured on this machine on 2026-08-14 — five conversations
 * were recorded against two to four not-ended registry rows each, one of them four times:
 *
 *   cd118e71…  44d649269a  .../worktrees/parse-cache-sqlite
 *              1da098e5cb  /home/mithrandir/agentistics
 *   03fa293a…  1ec25fc3d1  .../worktrees/cockpit-remount-flash
 *              e477d4e628  /home/mithrandir/agentistics
 *
 * Reading the two screens side by side showed identical text: one conversation, two assistants
 * typing into it. Claude Code itself notices and says so —
 *
 *   Remote Control not started here · another Claude Code on this machine
 *   (started 16s ago) already has Remote Control for this conversation
 *
 * — so the HARNESS knew and agentop, which started both, did not. It is not a display problem: the
 * two write to one transcript and to one working tree. The parse-cache session stopped itself, wrote
 * that somebody else was editing the same files, and declined to dispatch its next agent. It was
 * right, and the somebody was its own twin.
 *
 * ## Only EXACT evidence counts, and that is the whole design
 *
 * There are three ways to say which conversation a row drives, and they are not interchangeable:
 *
 *  1. the harness's own record (`~/.claude/sessions/<pid>.json`, matched by tmux session name or by
 *     pid) — a FACT, written by the process about itself;
 *  2. the id the registry stored while the session was up — a recollection, but an exact one;
 *  3. harness-and-directory inference — a GUESS, and the one that cannot tell two sessions of one
 *     repository apart.
 *
 * A lock built on (3) is a lock that jams: every session in a repository resolves to the same
 * conversation, so the second reopen in any repo would be refused forever, and people would learn to
 * work around the door rather than through it. So only (1) and (2) are ever admitted here — the same
 * line `session-view.ts` already draws between `metricsOf` (exact only) and `claimResume` (may
 * guess). The cost is stated plainly: a twin created without either kind of record is invisible to
 * this module and is not prevented. Refusing on a guess would be worse.
 *
 * ## Alive, not merely known
 *
 * The harness's records OUTLIVE their processes — 53 files on this machine against about a dozen live
 * ones. A conversation is therefore in use only when the row holding it is ALIVE, and the caller says
 * which those are. Reading the records alone would refuse to reopen anything that ever ran.
 */

/**
 * What kind of thing is holding a conversation.
 *
 * The distinction the lock was missing. `managed` is a row agentop hosts: it has a tmux pane you can
 * attach to, so "go and use it" is a real instruction. `process` is an assistant nobody here
 * started — one opened by hand, or a background agent — and for that one "go and use it" is not an
 * instruction at all: there is no pane to attach to, and the refusal named its DIRECTORY, which is
 * not somewhere you can go. It was a dead end, and it was the only thing on offer.
 *
 * A `process` holder is therefore not a refusal any more, it is a takeover: the conversation lives
 * on disk, so ending that process and reopening the SAME id under tmux loses nothing but the turn in
 * flight and puts the work back under every verb this screen has.
 */
export type ClaimKind = 'managed' | 'process'

/** A live session, as much of it as a refusal needs to name. */
export interface ClaimingSession {
  /** The row id — a managed session id, or an external row's id. */
  id: string
  /** Whether this is a row we host or a process we merely observed. */
  kind: ClaimKind
  /**
   * The OS pid, for a `process` holder — what a takeover has to end.
   *
   * Absent on a managed row: those are ended through the backend by session id, never by signalling
   * a pid, and a pid here would invite the wrong kind of kill.
   */
  pid?: number
  /**
   * Whether this session is running NOW.
   *
   * Load-bearing: a harness record left behind by a finished process would otherwise lock its
   * conversation out of ever being reopened, which is the one thing the reopen verb is for.
   */
  alive: boolean
  /**
   * The conversation it drives, from an EXACT source only — the harness's own record, or the id the
   * registry stored. Never a harness-and-directory inference. See the module header.
   */
  conversationId?: string
  /** What to call it when refusing, already display-ready. */
  label?: string
}

/** Who is holding a conversation. */
export interface ConversationHolder {
  /** The live row driving it. */
  id: string
  /** Its name, or its id when it has none — a refusal that names nothing cannot be acted on. */
  label: string
  /** See {@link ClaimKind}: `managed` is somewhere to go, `process` is something to take over. */
  kind: ClaimKind
  /** The pid to end when taking over a `process` holder. */
  pid?: number
}

/**
 * Conversation id → the live session driving it — PURE.
 *
 * FIRST alive holder wins, so the map is stable regardless of how many twins already exist: the
 * point is to name ONE session the user can go and look at, not to enumerate a mess.
 */
export function conversationsInUse(
  sessions: readonly ClaimingSession[],
): Map<string, ConversationHolder> {
  const held = new Map<string, ConversationHolder>()
  for (const s of sessions) {
    if (!s.alive || !s.conversationId) continue
    if (held.has(s.conversationId)) continue
    held.set(s.conversationId, {
      id: s.id,
      label: s.label?.trim() || s.id,
      kind: s.kind,
      ...(s.pid !== undefined ? { pid: s.pid } : {}),
    })
  }
  return held
}

/**
 * The live session already driving `conversationId`, or `undefined` — PURE.
 *
 * `exclude` is the row being replaced. Reopening a row onto its own conversation is the ordinary
 * case and must never be refused by the row itself: it is normally not alive at that point (that is
 * why it is being reopened), but a finished row can keep a lingering backend pane, and a lock that
 * refuses the very gesture it exists to protect is a lock nobody keeps.
 */
export function conversationHeldBy(
  held: ReadonlyMap<string, ConversationHolder>,
  conversationId: string | undefined,
  exclude?: string,
): ConversationHolder | undefined {
  if (!conversationId) return undefined
  const holder = held.get(conversationId)
  if (!holder || holder.id === exclude) return undefined
  return holder
}

/**
 * Conversations this machine is driving from more than one live session — PURE.
 *
 * Not used by the lock, which only ever asks about one conversation. This answers the OTHER half of
 * the same fact: the fleet that already has twins, from before the door was locked. Sorted by
 * conversation id so a report of it is stable between reads.
 */
export function duplicateConversations(
  sessions: readonly ClaimingSession[],
): { conversationId: string; holders: ConversationHolder[] }[] {
  const byConv = new Map<string, ConversationHolder[]>()
  for (const s of sessions) {
    if (!s.alive || !s.conversationId) continue
    const list = byConv.get(s.conversationId) ?? []
    list.push({
      id: s.id,
      label: s.label?.trim() || s.id,
      kind: s.kind,
      ...(s.pid !== undefined ? { pid: s.pid } : {}),
    })
    byConv.set(s.conversationId, list)
  }
  return [...byConv.entries()]
    .filter(([, holders]) => holders.length > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([conversationId, holders]) => ({ conversationId, holders }))
}

/**
 * Is the holder of a reopen the requested row ITSELF, left behind by a session that has ENDED? — PURE.
 *
 * `liveConversationHolders` lets backend liveness win over a stale `endedAt` (a CLI-owned relay can outlive
 * the stamp), so a row whose backend entry outlived its assistant — a structured relay still up after its
 * child exited, a pane left behind — is its own "holder". Reopening it then answered "that conversation is
 * already open in <this very row>", pointing at the row the person was looking at, which said it was NOT
 * running (owner, 2026-11-02: a pinned OpenCode leader under "Encerradas → Dormindo", unreopenable).
 *
 * `endedAt` alone is NOT that proof — a CLI-owned relay outlives a stale stamp and is reused
 * (`reopen-dup.test.ts`). So the row must ALSO be provably idle: its structured record exists and no relay
 * process of it runs. Then a reopen of THAT row reopens it — the caller ends the leftover entry first, so
 * the reopen can never become a second assistant beside a still-running one. A twin row, a foreign process,
 * or the requested row with no `endedAt` (a live row — reopening it stays idempotent) are not this case.
 */
export function staleSelfHolder(
  holder: ConversationHolder | undefined,
  replaces: string | undefined,
  replacedRow: { endedAt?: string } | undefined,
  /**
   * Is a process of this row PROVABLY not running? `true` only with positive proof (a structured record
   * whose relays are all gone — the "between two children" state the backend still lists as alive);
   * `undefined`/`false` when nobody can tell. Without proof the row stays its own live holder: a relay
   * owned by a CLI process outlives a stale `endedAt` and must be REUSED, never killed.
   */
  provablyIdle: boolean | undefined,
): boolean {
  return holder?.kind === 'managed'
    && replaces !== undefined
    && holder.id === replaces
    && Boolean(replacedRow?.endedAt)
    && provablyIdle === true
}
