/**
 * engine/fleet-hub.ts — what the host hands an engine as `EngineHostServices.fleet` (engine-api 1.4):
 * the fleet poll's CONFIRMED transitions, one per change, with no screen text.
 *
 * - **Confirmation is the event channel's, reused, not restated.** Every observed poll goes through
 *   `planEvents` (`events/event-plan.ts`) with this hub's own memory: a state counts only once it has
 *   been seen on two consecutive polls, and a first sighting is never a transition. So a pane that
 *   repaints for one frame never reaches an engine, and a host that just started never reports the
 *   whole fleet as having "changed".
 * - **Nobody listening costs nothing.** With no subscriber a poll is not even planned, and the memory
 *   is dropped — the first poll after someone subscribes is a seed, never a burst of transitions.
 * - **No text.** A transition carries ids, the harness, the EXACT conversation link (a row's
 *   `conversationId`, never a guess), two activities, a time, and — into `waiting-approval` — the
 *   dialog's option COUNT and whether one of them is a free-text field. Labels, screen lines, the
 *   task title and the directory stay here.
 * - **`answeredHere`.** The host's own answer route notes the choice it sent (`noteAnswered`); the
 *   next confirmed transition OUT of `waiting-approval` for that session carries it. A note is
 *   consumed by that transition, expires after `ANSWER_NOTE_TTL_MS`, and at most `MAX_ANSWER_NOTES`
 *   are held — so a route that answered a dialog nobody's poll ever confirmed leaves nothing behind.
 * - **A subscriber can only log.** One that throws is reported and the rest still receive.
 *
 * The polls are the server's own (`readRawFleetSnapshot`, what `/api/fleet` serves). A snapshot that
 * is `unavailable` (a failed poll answering with the previous reading) is not observed: it says
 * nothing new about the fleet.
 */
import type { EngineFleet, FleetDialog, FleetTransition, HarnessId } from '@agentistics/engine-api'
import { EMPTY_MEMORY, planEvents, type EventMemory } from '../events/event-plan'
import type { EventCandidate } from '../events/event-types'
import { isFreeTextOption } from '../sessions/approval-spec'
import type { SessionActivity } from '../sessions/types'

export const ANSWER_NOTE_TTL_MS = 2 * 60_000
export const MAX_ANSWER_NOTES = 64

/** The slice of a fleet row the hub reads. Everything else on the row stays out of reach. */
export interface FleetHubRow {
  id: string
  harness?: HarnessId
  conversationId?: string
  activity?: SessionActivity
  dialogOptions?: readonly { label: string }[]
  dialogUnreadable?: unknown
}

export interface FleetHub extends EngineFleet {
  /** One poll's rows. `nowMs` is the poll's own time. */
  observe(rows: readonly FleetHubRow[], nowMs: number): void
  /** The host's answer route sent `choice` to `managedId`. */
  noteAnswered(managedId: string, choice: number, nowMs?: number): void
  subscribers(): number
}

/** PURE. The dialog a row shows, as counts and kinds — `null` when the screen could not be read. */
export function dialogOf(row: FleetHubRow): FleetDialog | undefined {
  if (row.dialogUnreadable !== undefined || !row.dialogOptions || row.dialogOptions.length === 0) return undefined
  return {
    // Which KIND of dialog this is (a permission prompt, a question, a picker) is not read anywhere
    // reliably today; a count is. `unknown` says so rather than guessing.
    kind: 'unknown',
    optionCount: row.dialogOptions.length,
    hasFreeText: row.dialogOptions.some(o => isFreeTextOption(row.harness, o.label)),
  }
}

export function createFleetHub(o: { warn?: (m: string) => void } = {}): FleetHub {
  const warn = o.warn ?? ((m: string) => console.warn(m))
  const subs = new Set<(t: FleetTransition) => void>()
  let memory: EventMemory = EMPTY_MEMORY
  const notes = new Map<string, { choice: number; atMs: number }>()

  return {
    subscribe(cb) {
      subs.add(cb)
      return () => {
        subs.delete(cb)
        if (subs.size === 0) memory = EMPTY_MEMORY
      }
    },
    subscribers: () => subs.size,

    noteAnswered(managedId, choice, nowMs = Date.now()) {
      if (!Number.isInteger(choice) || choice < 1) return
      notes.delete(managedId)
      notes.set(managedId, { choice, atMs: nowMs })
      while (notes.size > MAX_ANSWER_NOTES) notes.delete(notes.keys().next().value!)
    },

    observe(rows, nowMs) {
      if (subs.size === 0) { memory = EMPTY_MEMORY; return }
      for (const [id, n] of notes) if (nowMs - n.atMs > ANSWER_NOTE_TTL_MS) notes.delete(id)
      const byId = new Map(rows.map(r => [r.id, r]))
      // Only what confirmation needs: an id and an activity (plus what the event type requires).
      const candidates: EventCandidate[] = rows.map(r => ({ id: r.id, cwd: '', ...(r.activity ? { activity: r.activity } : {}) }))
      const nowIso = new Date(nowMs).toISOString()
      const plan = planEvents({ memory, sessions: candidates, nowIso })
      memory = plan.memory
      for (const e of plan.events) {
        const row = byId.get(e.id)
        // A poll's events are always an activity; `turn-end` is the hook's, never planned here.
        if (!row?.harness || !e.from || e.kind === 'turn-end') continue
        const t: FleetTransition = {
          managedId: e.id,
          harness: row.harness,
          ...(row.conversationId ? { conversationId: row.conversationId } : {}),
          from: e.from,
          to: e.kind,
          at: nowIso,
        }
        if (e.kind === 'waiting-approval') {
          const d = dialogOf(row)
          if (d) t.dialog = d
        }
        if (e.from === 'waiting-approval') {
          const n = notes.get(e.id)
          if (n) { t.answeredHere = { choice: n.choice }; notes.delete(e.id) }
        }
        for (const cb of subs) {
          try { cb(t) } catch (err) { warn(`[engine] a fleet subscriber failed: ${String(err)}`) }
        }
      }
    },
  }
}

/** The server process's hub — what `hostServices()` hands an engine, and what the polls feed. */
export const fleetHub: FleetHub = createFleetHub()
