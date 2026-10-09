/**
 * sessions-host.ts — the poller. The only impure module of the monitor: it reads the registry, asks
 * the backend what exists, captures a frame per live session, reads the host's processes, and hands
 * the pure functions everything they need.
 *
 * Bound to its dependencies at construction (the `createSessionRegistry(file)` pattern), so a test
 * exercises the real logic with no tmux server and no `/proc`.
 *
 * Two states it must never confuse, and the reason this file has an `unavailable` field at all:
 * "nothing is running" and "this machine cannot tell". An empty list rendered as a confident zero is
 * the same defect `liveEmptyNotice` exists to prevent on the dashboard.
 */

import { anyGrant, scrubDeep, scrubTerminalLine } from '../vault/grants'
import type { ConversationLinkReason, HarnessId } from '@agentistics/core'
import { createLimiter } from '../utils'
import { retainKeys } from '../prune-keys'
import type { HarnessProcess } from '../live-sessions'
import { rulesFor } from './attention-rules'
import { approvalTail, attentionOf, digestFrame, frameTail } from './attention'
import { modeOf, modeSpecFor } from './mode-spec'
import { EMPTY_CONFIRM_MEMORY, confirmActivities, type ConfirmMemory } from './attention-confirm'
import type { ChatTurn } from './chat-turn'
import { transcriptReaderFor } from './harness-transcript'
import { markFleetPhase } from './fleet-profile'
import { readDialog, type DialogOption, type DialogUnreadable } from './dialog-choice'
import { markerReadOptions } from './approval-spec'
// Taking a running session back when its registry record is gone. See `session-adopt.ts`.
import { planAdoptions } from './session-adopt'
// The claim for harnesses that cannot be handed a conversation id. See `task-attribution.ts`.
import { planFirstSightingClaims } from './task-attribution'
import { HARNESS_PROCESS_TRANSCRIPTS } from './harness-session-file'
import { holderCollisions } from './process-transcript'
import { collisionKey, type ProcessTranscriptFile } from './process-conversation'
import { loadConversations, type Conversation } from './conversations'
import { HEARTBEAT_MS, planCrashGroup, type CrashGroup } from './crash-group'
import { emptyHarnessSessionIndex, type HarnessSessionIndex } from './harness-sessions'
import { chosenName } from './harness-session-file'
import { reconcileSessions } from './session-ref'
import {
  attentionCount, bellTransitions, buildSessionViews, type SessionView,
} from './session-view'
import type { ManagedSession, SessionActivity, SessionBackend } from './types'
import { calculateProcCpu, type ProcStatSample } from '../hardware-pure'
import { readProcRss, readProcStat } from '../hardware-probe'
import { procAvailable } from './proc-liveness'
import { backgroundWork } from './attention'
import { linkDecision, liveLinks, moveAllowed } from './relink-policy'

/** How often the cockpit refreshes. Five seconds is the interval the feature was specified at. */
export const SESSION_POLL_MS = Number(process.env.AGENTISTICS_SESSION_POLL_MS) > 0
  ? Number(process.env.AGENTISTICS_SESSION_POLL_MS)
  : 5_000

/** How much of the pane to read. Enough to hold a dialog and a footer, not the whole scrollback. */
const CAPTURE_LINES = 60

/** Frames are captured one per live session; four at a time keeps a large fleet from forking a
 *  process per session all at once. */
const CAPTURE_CONCURRENCY = 4

/** How much of what a session is saying to carry. Enough that a tall pane has something to fill it
 *  with; the pane cuts from the bottom to whatever it can actually draw. */
const TAIL_LINES = 8

/** How many role-tagged chat turns to carry for a readable session — see `harness-transcript.ts`. */
const TAIL_CHAT_TURNS = 6

/**
 * How much of a blocked session's screen to carry as the dialog.
 *
 * Ten lines holds a permission prompt with three options, its question and its footer — measured
 * against the frames `attention-rules.ts` was probed from. More would start carrying the
 * conversation above the dialog into a pane whose whole job is to show only what is being answered.
 */
const APPROVAL_LINES = 10

export interface SessionSnapshot {
  sessions: SessionView[]
  /** How many are waiting on a person. Drives the header counter. */
  attention: number
  /** Ids that JUST started waiting — the caller rings the bell for these. */
  rang: string[]
  polledAtMs: number
  /**
   * The sessions the machine took all at once, when there are any — see `crash-group.ts`.
   *
   * On the snapshot rather than derived from `sessions`, because it is a statement about a SET: a row
   * is in it because of when every other row was last alive, which no per-row rule can answer.
   */
  fell?: CrashGroup
  /**
   * Why this list may not be the whole truth, already a sentence.
   *
   * Set when the backend cannot run here at all, or when a poll failed and the sessions above are
   * the PREVIOUS snapshot rather than a fresh one.
   */
  unavailable?: string
}

export interface SessionsPoller {
  poll(): Promise<SessionSnapshot>
}

/**
 * One attempt at the OTHER exact link — the conversation named by a file a harness's own process
 * holds open (`HARNESS_PROCESS_TRANSCRIPTS`: agy's log by content, codex's rollout/lock and kimi's
 * session directory by name — see `agy-conversation.ts` and `process-transcript.ts`).
 *
 * Extracted from the poll loop below so a caller with exactly ONE freshly spawned row can retry it
 * on its own schedule — see `linkProcessConversationSoon` in `cli-start.ts`'s spawn wiring, and the
 * header there for why the poll loop alone is not enough. `pid` is a parameter rather than resolved
 * here so a caller walking many rows (the poll loop) still pays for `listPanePids()` once, not once
 * per row. `knownLog`, when given, skips re-resolving the pid's `/proc/<pid>/fd` — the caller has
 * already paid for it to run `holderCollisions` (see the poll loop and `linkProcessConversationSoon`
 * below), and it must never be asked twice: a pid whose pane exits between the two reads would
 * resolve differently the second time, on a check whose whole point is the answer being the SAME
 * fact both times.
 *
 * Returns `true` only once the link is actually RECORDED. A write that throws — `patchSession`
 * runs inside the registry's own cross-process file lock and can genuinely fail — must read as "not
 * linked, try again", not as success: `linkProcessConversationSoon`'s retry loop treats `true` as
 * terminal (`if (linked) return`), so reporting success on a failed write would spend this
 * session's one dedicated retry window on nothing and fall back entirely to the ordinary poll.
 */
export async function linkProcessConversation(o: {
  id: string
  harness: HarnessId
  pid: number
  knownLog?: ProcessTranscriptFile | null
  readProcessConversation: (harness: HarnessId, pid: number, knownLog?: ProcessTranscriptFile | null) => Promise<string | null>
  recordConversation: (id: string, conversationId: string, link: 'assigned', via?: ConversationLinkReason) => Promise<unknown>
}): Promise<boolean> {
  if (!HARNESS_PROCESS_TRANSCRIPTS[o.harness]) return false
  const found = await o.readProcessConversation(o.harness, o.pid, o.knownLog).catch(() => null)
  if (!found) return false
  try {
    await o.recordConversation(o.id, found, 'assigned', 'process-log')
    return true
  } catch {
    return false
  }
}

/**
 * The process-transcript link, SAMPLED densely for a while — for a harness that holds its file open
 * only while it writes (`holds: 'while-writing'`, kimi: 10–300 ms per write, measured; see
 * `process-transcript.ts`). One read per five-second poll sees such a file by luck; reading every
 * `intervalMs` for as long as the harness is writing sees it on its first burst, which is what makes
 * the link land within a second of the conversation existing, parallel rows in one folder included —
 * each row is resolved through its OWN pane's process, so no folder or time window is involved.
 *
 * Bounded three ways, because it is a tight loop: it asks only rows of `harness` with NO link yet
 * (re-read after every write it makes), it stops at `deadline()` (a getter, so a caller that sees
 * more activity can extend it without starting a second loop), and it stops the moment no such row
 * is left. The registry and the pane pids are read once per `refreshMs`, not once per tick.
 *
 * The collision guard is the poll's, narrowed to what a burst can afford: every candidate pid is
 * resolved on every tick and two HOLDERS naming one conversation link neither. `otherPids` — live
 * processes of this harness that agentop did not start, taken from the caller's last process scan —
 * join it, so a kimi resumed by hand in a terminal on our row's session still refuses.
 */
export async function sampleProcessLinks(o: {
  harness: HarnessId
  readRegistry: () => Promise<ManagedSession[]>
  listPanePids: () => Promise<Map<string, number> | undefined>
  resolveProcessLog: (harness: HarnessId, pid: number) => Promise<ProcessTranscriptFile | null>
  readProcessConversation: (harness: HarnessId, pid: number, knownLog?: ProcessTranscriptFile | null) => Promise<string | null>
  recordConversation: (id: string, conversationId: string, link: 'assigned', via?: ConversationLinkReason) => Promise<unknown>
  deadline: () => number
  intervalMs: number
  refreshMs?: number
  /** Ask only these rows (a freshly spawned one); every unlinked row of `harness` when absent. */
  onlyIds?: ReadonlySet<string>
  /**
   * Also ask the LINKED rows whose link follows their process (`relink-policy.ts`), so a kimi that
   * moved to a new session (`/new`) is caught while it writes — a once-a-poll read mostly misses a
   * file held only while writing. Set by the watcher-driven burst; a spawn's own run leaves it off,
   * or a resumed row would keep the loop busy for its whole spawn window to learn nothing.
   */
  follow?: boolean
  otherPids?: readonly number[]
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<number> {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const refreshMs = o.refreshMs ?? 1_000
  let writes = 0
  let open: { id: string; pid: number; current?: string }[] = []
  let live: ReadonlyMap<string, readonly string[]> = new Map()
  let refreshedAt = -Infinity
  const refresh = async (): Promise<void> => {
    refreshedAt = now()
    const [registry, pids] = await Promise.all([
      o.readRegistry().catch(() => [] as ManagedSession[]),
      o.listPanePids().catch(() => undefined),
    ])
    open = []
    live = liveLinks(registry, id => pids?.has(id) ?? false)
    for (const m of registry) {
      if (m.harness !== o.harness) continue
      const decision = linkDecision(m, 'process-file')
      if (decision === 'keep' || (decision === 'follow' && !o.follow)) continue
      if (o.onlyIds && !o.onlyIds.has(m.id)) continue
      const pid = pids?.get(m.id)
      if (pid !== undefined) open.push({ id: m.id, pid, ...(decision === 'follow' ? { current: m.conversationId! } : {}) })
    }
  }
  while (now() < o.deadline()) {
    if (now() - refreshedAt >= refreshMs) await refresh()
    if (open.length === 0) break
    const resolved = new Map<number, ProcessTranscriptFile | null>()
    const pids = new Set<number>([...open.map(r => r.pid), ...(o.otherPids ?? [])])
    await Promise.all([...pids].map(async pid => {
      resolved.set(pid, await o.resolveProcessLog(o.harness, pid).catch(() => null))
    }))
    const keyByHolder = new Map<number, string | null>()
    for (const r of resolved.values()) if (r) keyByHolder.set(r.holder, collisionKey(o.harness, r))
    const collided = holderCollisions(keyByHolder)
    let linkedAny = false
    for (const row of open) {
      const known = resolved.get(row.pid) ?? null
      if (!known || collided.has(known.holder)) continue
      const linked = await linkProcessConversation({
        id: row.id, harness: o.harness, pid: row.pid, knownLog: known,
        readProcessConversation: row.current === undefined
          ? o.readProcessConversation
          : async (h, p, k) => {
            const f = await o.readProcessConversation(h, p, k)
            return f && f !== row.current && moveAllowed(row.id, f, live) ? f : null
          },
        recordConversation: o.recordConversation,
      })
      if (linked) { writes++; linkedAny = true }
    }
    // A write changed what is left to ask: re-read rather than ask a linked row again.
    if (linkedAny) refreshedAt = -Infinity
    await sleep(o.intervalMs)
  }
  return writes
}

/** Rows the after-the-fact read may try per poll: each one lists a log directory. */
const AFTER_THE_FACT_PER_POLL = 5
/** A live row is left to the ordinary read this long before the after-the-fact one steps in. */
const AFTER_THE_FACT_LIVE_AFTER_MS = 30_000
const AFTER_THE_FACT_RETRY_MS = 60_000

export function createSessionsPoller(o: {
  backend: SessionBackend
  readRegistry: () => Promise<ManagedSession[]>
  scanProcesses: () => Promise<{ procs: HarnessProcess[] }>
  /**
   * Every conversation this machine knows about — what names an external session and what fills the
   * "closed, reopenable" rows. Injected and OPTIONAL: it is a filesystem read, and the tests that
   * exercise the poller's real logic must not need one.
   */
  loadConversations?: () => Promise<Conversation[]>
  /**
   * What each harness records about its OWN live sessions — the name typed inside a session, and
   * the conversation it is driving, both keyed EXACTLY. Injected and optional, like
   * `loadConversations`: it is a filesystem read, and a harness with no such file simply has none.
   */
  loadHarnessSessions?: () => Promise<HarnessSessionIndex>
  /**
   * Which recorded conversation ids, absent from the store, the harness's own transcript reader can
   * find on disk — `reopen-link.ts`'s `exactLinksOnDisk`. Injected and optional for the same reason
   * as the two above; without it a row whose conversation the store lacks offers no reopen.
   */
  findExactLinks?: (
    entries: readonly { harness?: HarnessId; cwd?: string; conversationId?: string }[],
    pool: readonly Conversation[],
  ) => Promise<Set<string>>
  /**
   * Stamp `lastSeenMs` on the sessions that are alive right now — the HEARTBEAT.
   *
   * Injected and optional for the same reason `loadConversations` is: it writes to disk, and the
   * tests that exercise the poller's real logic must not need a filesystem. It is what makes "these
   * fell together" answerable at all — see `crash-group.ts`.
   */
  touchSessions?: (ids: readonly string[], atMs: number) => Promise<unknown>
  /**
   * Record the conversation a managed row is EXACTLY known to be driving.
   *
   * Called only when the harness's own record says so and the registry does not already agree, so it
   * writes once per session rather than once per poll. It is what carries the exact id past the
   * session's own lifetime: the harness deletes its file when the process goes, and a `lost` row
   * with nothing recorded falls back to the harness-and-directory guess that cannot tell two
   * sessions of one repository apart — the guess that once reopened three rows onto one
   * conversation.
   */
  recordConversation?: (
    id: string,
    conversationId: string,
    /**
     * HOW the link was established — see `ManagedSession.conversationLink`. `assigned` for the
     * harness's own exact record; `observed` for a first-sighting claim. One writer, told which
     * kind: a second path to this field is a second place for the two to disagree.
     */
    link: 'assigned' | 'observed',
    /** WHERE the link came from (LIVE.1) — one of the three recording sites says so. */
    via?: ConversationLinkReason,
  ) => Promise<unknown>
  /**
   * The conversation the process behind one of our panes is writing, from the log that process
   * holds open. `null` whenever nothing can say — see `process-conversation.ts`.
   *
   * Injected like every other read here, so the poller stays testable without a `/proc`.
   */
  /** Exclusive managed log; also works without a live pid. */
  readManagedConversation?: (harness: HarnessId, id: string) => Promise<string | null>
  readProcessConversation?: (harness: HarnessId, pid: number, knownLog?: ProcessTranscriptFile | null) => Promise<string | null>
  /**
   * Which log a pid holds open, WITHOUT reading its content — see `process-conversation.ts`'s
   * `resolveProcessLog`. Used to build the collision guard (`holderCollisions`) BEFORE any content
   * is trusted: a fleet with two live agy processes sharing one log (they name it by SECOND) must
   * never have either one linked from it, and that can only be known by resolving every candidate
   * pid's log FIRST. Optional like every other `/proc` read here.
   */
  resolveProcessLog?: (harness: HarnessId, pid: number) => Promise<ProcessTranscriptFile | null>
  /**
   * The conversation a row's process created, recovered from the log it LEFT BEHIND — for the row
   * whose process ended (or whose live read never landed) before anything linked it. See
   * `readSpawnWindowConversation`. Optional like every other read here.
   */
  readSpawnWindowConversation?: (o: {
    harness: HarnessId
    cwd: string
    spawnedMs: number
    rivalSpawnsMs?: readonly number[]
    taken?: ReadonlySet<string>
  }) => Promise<string | null>
  /**
   * Persist the name a managed row was given INSIDE the harness (`/rename`), so the title survives
   * the process.
   *
   * Mirror of `recordConversation`, and for the same reason: the harness deletes its own session
   * file when the process ends, so a name that lived only there is lost the instant the session
   * finishes — the displayed title then flips to a different source and `CTRL+F` can no longer find
   * the row by the name it wore a moment ago. Called ONLY when the live, non-derived name disagrees
   * with what the registry already holds, so it writes once per rename and not once per poll.
   */
  recordHarnessName?: (id: string, name: string, since?: number) => Promise<unknown>
  /**
   * Write registry records for sessions the backend is running and the registry has lost.
   *
   * Injected and optional for the same reason the two above are: it writes to disk. Called only with
   * a non-empty list, so a fleet with nothing to adopt — the ordinary case — never touches the file.
   * What may be adopted at all is the pure `planAdoptions`.
   */
  adoptSessions?: (records: readonly ManagedSession[]) => Promise<unknown>
  now?: () => number
  captureLines?: number
  /** Overridable so a test can drive several heartbeats without waiting a minute for each. */
  heartbeatMs?: number
}): SessionsPoller {
  const now = o.now ?? (() => Date.now())
  const lines = o.captureLines ?? CAPTURE_LINES
  const heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS
  const limit = createLimiter(CAPTURE_CONCURRENCY)

  // Carried between polls: what each session's screen looked like, and what state it was in. The
  // first is how movement is detected; the second is what makes the bell a transition.
  let prevDigest = new Map<string, string>()
  let prevActivity = new Map<string, SessionActivity>()
  // The raw per-poll reading is noisy: a session that just finished, or a pane a plugin repainted,
  // reads `working` then `waiting` across two polls with nothing changed. `confirmActivities` turns
  // that into a CONFIRMED reading — a needs-you state must be seen twice before the counter believes
  // it, while a return to work is believed at once — so the "waiting on you" count stops lying.
  let confirmMemory: ConfirmMemory = EMPTY_CONFIRM_MEMORY
  const prevProcStats = new Map<number, ProcStatSample>()
  // When the after-the-fact read last ran for a row. A DEAD row's answer cannot change (its log is
  // final), so it runs once; a LIVE row the live read has not linked gets another go every minute.
  const afterTheFactTried = new Map<string, number>()
  let last: SessionSnapshot | null = null
  /**
   * When the heartbeat last wrote. `-Infinity` so the FIRST poll always stamps.
   *
   * Stamping immediately matters: a machine that comes up, has three sessions reopened into it and
   * then falls again inside the first minute would otherwise have three rows carrying only their
   * creation stamps — which is fine — but a fleet that was already running when this process started
   * would carry nothing at all, and would sit out the next crash entirely.
   */
  let lastHeartbeatMs = -Infinity

  async function poll(): Promise<SessionSnapshot> {
    const nowMs = now()

    const blocked = await o.backend.unavailable().catch(() => undefined)
    if (blocked) {
      // The backend cannot run here. That is a sentence, not an empty fleet.
      const snap: SessionSnapshot = {
        sessions: [], attention: 0, rang: [], polledAtMs: nowMs, unavailable: blocked,
      }
      last = snap
      return snap
    }

    try {
      const gatherStart = performance.now()
      // Each of the five is timed SEPARATELY as well as together, because the two numbers disagreed
      // and the disagreement is the whole question. Measured individually in a bare process, none
      // of them exceeded 415ms; measured here inside this `Promise.all`, the group took 2961ms. A
      // group total cannot say which member carries that, and five concurrent readers of the same
      // disk are exactly the shape that makes a per-member number differ from a solo one — so the
      // per-member marks are taken IN PLACE, under the concurrency they actually run under, rather
      // than inferred from a solo timing that has already proved not to transfer.
      const timed = <T>(label: string, p: Promise<T>): Promise<T> => {
        const started = performance.now()
        return p.then(v => { markFleetPhase(`poll: gather · ${label}`, started); return v })
      }
      const [registry, backendSessions, processes, conversations, harnessSessions] = await Promise.all([
        timed('readRegistry', o.readRegistry()),
        timed('backend.list', o.backend.list()),
        timed('scanProcesses', o.scanProcesses().then(r => r.procs).catch(() => [] as HarnessProcess[])),
        // History is an enrichment, never a prerequisite: a store that cannot be read costs the
        // closed rows, not the running ones.
        timed('loadConversations',
          o.loadConversations ? o.loadConversations().catch(() => [] as Conversation[]) : Promise.resolve([])),
        // Same rule: unreadable costs the harness's own names and its exact conversation ids, and
        // every row falls back to behaving exactly as it did before this existed.
        timed('loadHarnessSessions',
          o.loadHarnessSessions
            ? o.loadHarnessSessions().catch(() => emptyHarnessSessionIndex())
            : Promise.resolve(emptyHarnessSessionIndex())),
      ])
      markFleetPhase('poll: gather (registry/backend.list/scanProcesses/conversations/harnessSessions)', gatherStart)

      const reconciled = reconcileSessions(registry, backendSessions)
      const harnessOf = new Map(registry.map(r => [r.id, r.harness]))

      // Take back any session the backend is running that the registry has lost. It is not a
      // theoretical case: the registry's write queue is per PROCESS, several agentop processes write
      // the same file, and a record added by a short-lived one has been observed erased by a
      // longer-lived one — leaving the user sitting in a session the cockpit could no longer name,
      // attach to, rename or kill. Adoption never invents anything: see `session-adopt.ts`. It is
      // idempotent by construction (an adopted row stops being `unregistered`), so it writes once.
      if (o.adoptSessions) {
        const adoptStart = performance.now()
        const adopt = planAdoptions({
          rows: reconciled,
          byManagedId: harnessSessions.byManagedId,
          harness: 'claude',
          nowIso: new Date(nowMs).toISOString(),
        })
        // Best effort, exactly like the heartbeat: a registry that cannot be written costs the
        // adoption, never the fleet on screen.
        if (adopt.length > 0) await o.adoptSessions(adopt).catch(() => undefined)
        markFleetPhase(`poll: adoptSessions x${adopt.length}`, adoptStart)
      }

      const nextDigest = new Map<string, string>()
      const activity = new Map<string, SessionActivity>()
      /** Rows whose reading is backed by more than movement — see `confirmActivities`. */
      const corroborated = new Set<string>()
      /** Rows with work running that is not their own turn — see `backgroundWork`. */
      const background = new Set<string>()
      const tails = new Map<string, string[]>()
      const approvals = new Map<string, string[]>()
      /** The harness mode each running session is in — see `mode-spec.ts`. */
      const modes = new Map<string, { id: string; label: string }>()
      const dialogOptions = new Map<string, DialogOption[]>()
      const dialogSelect = new Map<string, 'numbered' | 'marker'>()
      /*
       * WHY THE REFUSAL IS CARRIED AND NOT JUST THE OPTIONS.
       *
       * An empty option list means two opposite things — "there is no menu" and "there IS a menu
       * and it could not be read" — and the second one must never reach a confirm button. Carrying
       * only the options threw that distinction away at the source. See `readDialog`.
       */
      const dialogUnreadable = new Map<string, DialogUnreadable>()
      const chatTails = new Map<string, ChatTurn[]>()

      const captureStart = performance.now()
      await Promise.all(reconciled.map(r => limit(async () => {
        const b = r.backend
        if (!b) return // `lost`: the backend has nothing to capture and nothing to report.
        if (!b.alive) { activity.set(r.id, 'exited'); return }

        const frame = await o.backend.capture(r.id, lines).catch(() => [] as string[])
        // WHICH MODE the harness is in, read off the same frame the state came from — see
        // `mode-spec.ts`. `null` for a harness nobody has probed and for a frame with no footer yet,
        // and the row then simply carries none.
        {
          const m = modeOf(frame, modeSpecFor(r.managed?.harness))
          if (m) modes.set(r.id, { id: m.id, label: m.label })
        }
        const frameDigest = digestFrame(frame)
        nextDigest.set(r.id, frameDigest)
        tails.set(r.id, anyGrant() ? frameTail(frame, TAIL_LINES).map(l => scrubTerminalLine(r.id, l)) : frameTail(frame, TAIL_LINES))

        const harness = harnessOf.get(r.id)

        // Read the harness's own transcript instead of the screen, wherever BOTH halves hold: the
        // conversation id is EXACT and somebody has written a reader for that harness's format
        // (`harness-transcript.ts`). Either missing and the raw screen tail above stays the row's
        // only detail content — never a conversation guessed from harness-and-directory.
        //
        // TWO exact sources, and they are not interchangeable. Claude's own
        // `~/.claude/sessions/<pid>.json` names our tmux session, which is the link for a session
        // we did not start; `ManagedSession.conversationId` is the id agentop handed the CLI
        // itself, which is the only one the other harnesses can ever have. Claude's own record is
        // preferred where both exist — it is the LIVE one, while the registry's was recorded once.
        const cwd = r.managed?.cwd
        const conversationId = harnessSessions.byManagedId.get(r.id)?.sessionId
          ?? r.managed?.conversationId
        const transcript = transcriptReaderFor(harness)
        if (transcript && conversationId) {
          const path = await transcript
            .resolve({ conversationId, ...(cwd ? { cwd } : {}) })
            .catch(() => null)
          if (path) {
            const turns = await transcript.readRecent(path, TAIL_CHAT_TURNS).catch(() => [] as ChatTurn[])
            if (turns.length > 0) chatTails.set(r.id, anyGrant() ? await scrubDeep(r.id, turns) : turns)
          }
        }

        const rules = harness ? rulesFor(harness) : undefined
        // CORROBORATED: the harness said so itself. A `working` read from MOVEMENT ALONE, on a
        // harness that does print a working marker, is most likely a repaint — and that is what
        // made a row alternate between `working` and `needs you` continuously, with a notification
        // each time. A harness with NO marker has nothing better than movement, so its reading
        // stands. See `confirmActivities`.
        if (!rules?.working?.length || rules.working.some(re => re.test(frame.join('\n')))) {
          corroborated.add(r.id)
        }
        const before = prevDigest.get(r.id)
        if (backgroundWork({ frame, ...(rules ? { rules } : {}) })) background.add(r.id)
        // A5.4: a backend that KNOWS the state (an ACP agent states it) is believed over the frame.
        const stated = o.backend.activityOf?.(r.id)
        if (stated) corroborated.add(r.id)
        const state = stated ?? attentionOf({
          alive: true,
          lastActivityMs: b.lastActivityMs,
          nowMs,
          frame,
          frameDigest,
          ...(before !== undefined ? { prevDigest: before } : {}),
          ...(rules ? { rules } : {}),
        })
        activity.set(r.id, state)
        // The dialog is kept from the frame that DECIDED the state, so the two can never describe
        // different moments — and it costs nothing extra, the frame is already here.
        const statedDialog = state === 'waiting-approval' ? o.backend.dialogOf?.(r.id) : undefined
        const tail = (): string[] => anyGrant() ? approvalTail(frame, APPROVAL_LINES).map(l => scrubTerminalLine(r.id, l)) : approvalTail(frame, APPROVAL_LINES)
        if (statedDialog) {
          approvals.set(r.id, tail())
          dialogOptions.set(r.id, statedDialog.map((label, i) => ({ number: i + 1, label: anyGrant() ? scrubTerminalLine(r.id, label) : label, selected: i === 0 })))
          dialogSelect.set(r.id, 'numbered')
        } else if (state === 'waiting-approval') {
          approvals.set(r.id, tail())
          // Read from the SAME frame that decided the state, so what is offered and what the state
          // says can never describe different moments. Empty when the screen cannot be parsed with
          // confidence, which the UI reports rather than papering over.
          const dialog = readDialog(frame, markerReadOptions(harness))
          if (dialog.options.length > 0) dialogOptions.set(r.id, dialog.options)
          // From the SAME read as the options: how they are picked is a fact about this frame, and
          // deriving it again downstream is how a numberless dialog gets offered a digit.
          if (dialog.select) dialogSelect.set(r.id, dialog.select)
          if (dialog.kind === 'unreadable') dialogUnreadable.set(r.id, dialog.reason!)
        }
      })))
      markFleetPhase(`poll: capture+chatTail x${reconciled.length} (concurrency ${CAPTURE_CONCURRENCY})`, captureStart)

      // The heartbeat: one write, one timestamp, every session the backend reports as ALIVE. See
      // `crash-group.ts` for why one shared timestamp is what makes the grouping exact.
      const aliveIds = backendSessions.filter(b => b.alive).map(b => b.id)
      if (o.touchSessions && nowMs - lastHeartbeatMs >= heartbeatMs) {
        lastHeartbeatMs = nowMs
        // Best effort, and never awaited into the poll's own failure path: a registry that cannot be
        // written costs the crash group, not the fleet on screen.
        await o.touchSessions(aliveIds, nowMs).catch(() => undefined)
      }

      // The exact conversation, written down while there is still a harness to ask. Only where it
      // would CHANGE the registry, so this is one write per session and not one per poll.
      const recordConvStart = performance.now()
      let recordConvWrites = 0
      if (o.recordConversation) {
        for (const m of registry) {
          const exact = harnessSessions.byManagedId.get(m.id)?.sessionId
          if (!exact || m.conversationId === exact) continue
          recordConvWrites++
          await o.recordConversation(m.id, exact, 'assigned', 'harness-session-file').catch(() => undefined)
        }
      }
      markFleetPhase(`poll: recordConversation x${recordConvWrites}`, recordConvStart)

      // The pane pids, read ONCE for the two things below that need them: the per-process
      // conversation link, and the hardware sample further down. Two `tmux list-panes` calls a poll
      // for one answer is a second place for them to disagree about which pid is which row.
      const panePids = await o.backend.listPanePids?.().catch(() => new Map<string, number>())

      // The OTHER exact link: the conversation named by a file the harness's own process holds
      // OPEN (`HARNESS_PROCESS_TRANSCRIPTS` — agy's log, codex's rollout and thread lock, kimi's
      // session directory; see `agy-conversation.ts` and `process-transcript.ts` for why none of the
      // three has an assign flag or a session record to link by instead).
      //
      // Recorded as `assigned` rather than `observed`: this is the harness's own statement about
      // the conversation it created, read out of the process WE spawned into WE own's pane — not
      // the first-sighting claim below, which infers from time and directory and refuses on any
      // ambiguity. The content read is asked only of a row with NO link yet; the COLLISION check
      // below additionally sweeps `/proc/<pid>/fd` for every LIVE process of such a harness this
      // poll already knows about (not only our own unlinked rows — see its own comment), which costs
      // one extra sweep per already-linked live session of those harnesses too. Nothing at all on a
      // fleet without agy, codex or kimi: this whole block is a no-op there. kimi holds its files
      // only while writing, so this once-a-poll read mostly misses it; `sampleProcessLinks` below is
      // what catches it, run in bursts while kimi's transcript tree is being written.
      // Exclusive managed logs cannot collide even when three rows start in the same second/cwd.
      // Being exclusive, the log also MOVES a reopened/assigned link when the process goes on to
      // another conversation (`/new`) — see `relink-policy.ts`. A move that would put two live rows
      // on one conversation, or that two logs name at once, is refused.
      const managedLogLinked = new Set<string>()
      const isLive = (id: string): boolean => panePids?.has(id) ?? false
      let live = liveLinks(registry, isLive)
      if (o.recordConversation && o.readManagedConversation) {
        const managedFound: Array<[ManagedSession, string]> = []
        for (const m of registry) {
          if (linkDecision(m, 'managed-log') === 'keep') continue
          const found = await o.readManagedConversation(m.harness, m.id).catch(() => null)
          if (!found) continue
          managedLogLinked.add(m.id)
          if (found !== m.conversationId) managedFound.push([m, found])
        }
        const movesTo = new Map<string, number>()
        for (const [m, found] of managedFound) if (m.conversationId) movesTo.set(found, (movesTo.get(found) ?? 0) + 1)
        for (const [m, found] of managedFound) {
          if (m.conversationId && !moveAllowed(m.id, found, live, movesTo.get(found))) continue
          try {
            await o.recordConversation(m.id, found, 'assigned', 'process-log')
            // The fallback below must not overwrite the newer managed log with an old open DB.
            m.conversationId = found
            m.conversationLinkVia = 'process-log'
          } catch { /* retry next poll */ }
        }
        // The moves above changed which live row drives what; the route below guards against that.
        live = liveLinks(registry, isLive)
      }
      const procLinkStart = performance.now()
      let procLinkWrites = 0
      if (o.recordConversation && o.readProcessConversation) {
        // THE COLLISION GUARD, resolved BEFORE any content is trusted — see `agyLogCollisions`'s and
        // `holderCollisions`' own headers for what was actually measured. agy names its log by
        // SECOND, so two live processes of such a harness — anywhere on this machine, not only
        // among our own unlinked rows, because the process that collides with ours need not be one
        // agentop started — can hold the identical file open, and the file's content then cannot be
        // attributed to either of them. Every candidate pid's log is resolved once, up front, so the
        // read below never has to guess which pid a line belongs to. For codex and kimi the
        // identity compared is the CONVERSATION the path names: two panes running `codex resume` on
        // one thread both hold its rollout, and neither may be linked from it.
        const logByPid = new Map<string, ProcessTranscriptFile | null>()
        const harnessOfPid = new Map<string, HarnessId>()
        if (o.resolveProcessLog) {
          const candidates = new Map<string, HarnessId>()
          for (const p of processes) {
            if (p.pid !== undefined && HARNESS_PROCESS_TRANSCRIPTS[p.harness]) {
              candidates.set(String(p.pid), p.harness)
            }
          }
          // Belt and braces: a row's own pane pid, in case `scanProcesses` (a `/proc` scan matched
          // by command line) missed one that tmux's own bookkeeping still knows about.
          for (const m of registry) {
            if (!HARNESS_PROCESS_TRANSCRIPTS[m.harness]) continue
            const pid = panePids?.get(m.id)
            if (pid !== undefined) candidates.set(String(pid), m.harness)
          }
          await Promise.all([...candidates].map(async ([pidKey, harness]) => {
            harnessOfPid.set(pidKey, harness)
            logByPid.set(pidKey, await o.resolveProcessLog!(harness, Number(pidKey)).catch(() => null))
          }))
        }
        // Keyed by the HOLDER, never by the pid asked about: `scanProcesses` reports a codex's node
        // shim and its native binary as two processes, and both resolve to the one rollout the binary
        // holds — keyed by the asked pid, every codex would collide with itself. See
        // `holderCollisions`.
        const keyByHolder = new Map<number, string | null>()
        for (const [pidKey, resolved] of logByPid) {
          if (resolved) keyByHolder.set(resolved.holder, collisionKey(harnessOfPid.get(pidKey)!, resolved))
        }
        const collidedHolders = holderCollisions(keyByHolder)

        for (const m of registry) {
          if (!HARNESS_PROCESS_TRANSCRIPTS[m.harness] || managedLogLinked.has(m.id)) continue
          // A link is not final: the SAME process can go on to create another conversation (agy
          // after a model switch, a /clear, a resume; codex/kimi after /new), and the pane then shows
          // answers the old link never will — the web chat sat on "delivered, not read" while the
          // terminal answered. So a linked row keeps being asked and a DIFFERENT id re-links it —
          // a row linked by an id we handed the CLI (a reopen) only when this file is exclusive to
          // its process (`relink-policy.ts`), and never onto a conversation another live row drives.
          const decision = linkDecision(m, 'process-file')
          if (decision === 'keep') continue
          const relink = decision === 'follow'
          const pid = panePids?.get(m.id)
          if (!pid) continue
          // REFUSE rather than read a log another live process also has open — see the header
          // above. Left unlinked exactly as a pid with no log at all is: the next poll re-resolves,
          // so a collision that clears (one process ends) is retried, never permanently refused.
          const known = logByPid.get(String(pid))
          if (known && collidedHolders.has(known.holder)) continue
          const linked = await linkProcessConversation({
            id: m.id, harness: m.harness, pid,
            ...(logByPid.has(String(pid)) ? { knownLog: known ?? null } : {}),
            readProcessConversation: relink
              ? async (h, p, k) => {
                const f = await o.readProcessConversation!(h, p, k)
                return f && f !== m.conversationId && moveAllowed(m.id, f, live) ? f : null
              }
              : o.readProcessConversation,
            recordConversation: o.recordConversation,
          })
          if (linked) procLinkWrites++
        }
      }
      markFleetPhase(`poll: processConversation x${procLinkWrites}`, procLinkStart)

      // THE POST-MORTEM LINK. The block above can only name a conversation while the process is
      // ALIVE (it reads `/proc/<pid>/fd`), so a session that ended before that read landed kept
      // `conversationId: null` forever — no chat, and "cannot be reopened" — although the log it
      // left behind says which conversation it made. See `conversationFromSpawnWindow`.
      const afterStart = performance.now()
      let afterWrites = 0
      if (o.recordConversation && o.readSpawnWindowConversation) {
        let budget = AFTER_THE_FACT_PER_POLL
        const taken = new Set(registry.map(m => m.conversationId).filter((v): v is string => Boolean(v)))
        for (const m of registry) {
          if (budget <= 0) break
          if (m.conversationId || !HARNESS_PROCESS_TRANSCRIPTS[m.harness]?.afterTheFact) continue
          const spawnedMs = Date.parse(m.createdAt)
          if (!Number.isFinite(spawnedMs)) continue
          const alive = panePids?.get(m.id) !== undefined
          // A live row gets the ordinary read (and its collision guard) first.
          if (alive && nowMs - spawnedMs < AFTER_THE_FACT_LIVE_AFTER_MS) continue
          const last = afterTheFactTried.get(m.id)
          if (last !== undefined && (!alive || nowMs - last < AFTER_THE_FACT_RETRY_MS)) continue
          afterTheFactTried.set(m.id, nowMs)
          budget--
          const found = await o.readSpawnWindowConversation({
            harness: m.harness,
            cwd: m.cwd,
            spawnedMs,
            rivalSpawnsMs: registry
              .filter(r => r.id !== m.id && r.harness === m.harness && r.cwd === m.cwd)
              .map(r => Date.parse(r.createdAt))
              .filter(Number.isFinite),
            taken,
          }).catch(() => null)
          if (!found) continue
          try {
            await o.recordConversation(m.id, found, 'assigned', 'first-sighting')
            taken.add(found)
            afterWrites++
          } catch {
            afterTheFactTried.delete(m.id) // the write failed, not the read: try again next poll
          }
        }
      }
      markFleetPhase(`poll: afterTheFactConversation x${afterWrites}`, afterStart)

      // The conversation link for the harnesses no `assignId` can be given (codex, kimi,
      // antigravity, gemini): claimed ONCE, at first sighting, and refused on any ambiguity. Written
      // through the same `recordConversation` as the exact link above, because a second path to one
      // field is a second place for the two to disagree. See `task-attribution.ts` — rows already
      // carrying a link are skipped there, so this too writes once per session, not once per poll.
      const claimStart = performance.now()
      let claimWrites = 0
      if (o.recordConversation) {
        const plan = planFirstSightingClaims({
          rows: registry.map(m => ({
            id: m.id,
            harness: m.harness,
            cwd: m.cwd,
            spawnedMs: Date.parse(m.createdAt) || 0,
            ...(m.conversationId ? { conversationId: m.conversationId } : {}),
          })),
          candidates: conversations.map(c => ({
            sessionId: c.sessionId,
            harness: c.harness,
            cwd: c.cwd,
            startedMs: c.startedMs,
          })),
          claimed: new Set(
            registry.map(m => m.conversationId).filter((v): v is string => Boolean(v)),
          ),
        })
        for (const claim of plan.claims) {
          claimWrites++
          await o.recordConversation(claim.rowId, claim.sessionId, 'observed', 'first-sighting').catch(() => undefined)
        }
      }
      markFleetPhase(`poll: firstSightingClaims x${claimWrites}`, claimStart)

      // The `/rename` name, captured WHILE there is still a harness file to read it from, so the
      // title outlives the process. Only a name a PERSON typed (`chosenName` drops the harness's own
      // invented `agentistics-77`), and only when it CHANGED — one write per rename, never per poll.
      const recordNameStart = performance.now()
      let recordNameWrites = 0
      if (o.recordHarnessName) {
        for (const m of registry) {
          const file = harnessSessions.byManagedId.get(m.id)
          const name = chosenName(file)
          if (!name || (m.harnessName === name && m.harnessNameSince === file?.nameSince)) continue
          recordNameWrites++
          await o.recordHarnessName(m.id, name, file?.nameSince).catch(() => undefined)
        }
      }
      markFleetPhase(`poll: recordHarnessName x${recordNameWrites}`, recordNameStart)

      // Decided against the BACKEND's own list rather than the reconciled statuses, because that is
      // the question: a row the backend has never heard of is one the machine took.
      const backendIds = new Set(backendSessions.map(b => b.id))
      const fell = planCrashGroup({ entries: registry, backendIds })

      const canReadProc = await procAvailable()
      const sessionHardware = new Map<string, { pid?: number; cpuPercent?: number | null; rssBytes?: number | null }>()
      const procStatStart = performance.now()
      if (canReadProc) {
        const seenPids = new Set<number>()
        for (const r of reconciled) {
          const own = harnessSessions.byManagedId.get(r.id)
          const harness = r.managed?.harness
          const cwd = r.managed?.cwd
          // A harness record whose process is KNOWN dead (`alive === false`) names no pid worth
          // sampling: hundreds of them pile up (the harness never removes a dead process's file), and
          // each cost two failed /proc reads on every poll.
          const ownPid = own && own.alive !== false ? own.pid : undefined
          const paneOwn = panePids?.get(r.id)
          const liveProc = ownPid !== undefined || paneOwn !== undefined ? undefined : processes.find(
            p =>
              p.sessionId === r.id ||
              (Boolean(harness) &&
                Boolean(cwd) &&
                p.harness === harness &&
                (p.cwd === cwd || p.cwd.startsWith(cwd! + '/') || cwd!.startsWith(p.cwd + '/'))),
          )
          const pid = ownPid ?? paneOwn ?? liveProc?.pid
          if (pid && Number.isFinite(pid) && pid > 0) {
            const currStat = await readProcStat(pid, nowMs)
            const rssBytes = await readProcRss(pid)
            let cpuPercent: number | null = null
            if (currStat) {
              const prevStat = prevProcStats.get(pid)
              cpuPercent = calculateProcCpu(prevStat, currStat)
              prevProcStats.set(pid, currStat)
              seenPids.add(pid)
            }
            sessionHardware.set(r.id, { pid, cpuPercent, rssBytes })
          }
        }
        // A pid not sampled this poll is a process that is gone (or a session no longer listed);
        // without this every pid the fleet ever had stayed in the map for the life of the server.
        retainKeys(prevProcStats, seenPids)
      }
      if (canReadProc) markFleetPhase(`poll: procStat+procRss x${reconciled.length} (sequential)`, procStatStart)

      // Confirm the raw readings before anything downstream sees them: the count, the sort, the bell
      // and the TUI all read `activity`, so confirming here is the one place that makes every surface
      // honest at once. A needs-you state must hold for two polls to be believed; a return to work is
      // believed immediately (see `attention-confirm.ts`). The dialog/approval frames captured above
      // are keyed to the RAW `waiting-approval` reading and only reach a row once its CONFIRMED state
      // is `waiting-approval` too — `buildSessionViews` gates them on `activity`.
      const confirm = confirmActivities(confirmMemory, activity, corroborated)
      confirmMemory = confirm.memory
      const confirmedActivity = confirm.activities

      // Rows that could be offered a reopen from their EXACT link — not running, holding a recorded
      // id. `findExactLinks` asks only about ids the store does not carry, and memoizes.
      const exactLinksOnDisk = o.findExactLinks
        ? await o.findExactLinks(
          reconciled
            .filter(r => r.managed && (r.managed.endedAt || r.status === 'lost' || r.status === 'exited'))
            .map(r => ({
              ...(r.managed!.harness ? { harness: r.managed!.harness } : {}),
              ...(r.managed!.cwd ? { cwd: r.managed!.cwd } : {}),
              ...(r.managed!.conversationId ? { conversationId: r.managed!.conversationId } : {}),
            })),
          conversations,
        ).catch(() => new Set<string>())
        : undefined

      const sessions = buildSessionViews({
        reconciled,
        ...(exactLinksOnDisk ? { exactLinksOnDisk } : {}),
        activity: confirmedActivity,
        background,
        tails,
        chatTails,
        approvals,
        modes,
        dialogOptions,
        dialogSelect,
        dialogUnreadable,
        processes,
        conversations,
        harnessSessions,
        sessionHardware,
        ...(fell ? { fell: new Set(fell.entries.map(e => e.id)) } : {}),
      })
      const rang = bellTransitions(prevActivity, sessions)

      prevDigest = nextDigest
      prevActivity = new Map(
        sessions
          .filter((s): s is SessionView & { activity: SessionActivity } => s.activity !== undefined)
          .map(s => [s.id, s.activity]),
      )

      const snap: SessionSnapshot = {
        sessions, attention: attentionCount(sessions), rang, polledAtMs: nowMs,
        ...(fell ? { fell } : {}),
      }
      last = snap
      return snap
    } catch (e) {
      // A failed poll keeps the previous answer and SAYS the refresh failed. Returning an empty
      // list would report every running session as gone the moment tmux hiccups.
      const message = e instanceof Error ? e.message : String(e)
      return {
        sessions: last?.sessions ?? [],
        attention: last?.attention ?? 0,
        rang: [],
        polledAtMs: nowMs,
        // Carried with the rest of the previous answer: the crash group is a fact about the same
        // sessions this snapshot is still showing, and dropping it would make the offer to reopen
        // them blink out on exactly the tick that already told the user something went wrong.
        ...(last?.fell ? { fell: last.fell } : {}),
        unavailable: `could not refresh sessions: ${message}`,
      }
    }
  }

  return { poll }
}
