/**
 * notifier.ts — an event that was written, delivered to whoever asked for it.
 *
 * Writing and delivering are separate steps on purpose. The write is what makes the channel work
 * for a consumer that is not running; delivery is what makes it work SOONER for one that is. A
 * failed delivery is therefore never fatal and never silent: the event is already durable, and the
 * failure is reported so that "my notifications stopped arriving" is a thing the user can be told
 * rather than something they eventually notice.
 *
 * ## Batching
 *
 * One poll can produce several events, and five sessions finishing at once must interrupt a working
 * assistant ONCE. So the events of one batch that a given subscription wants become one peer
 * message. Desktop notifications are the opposite: a toast per event is what a person expects, so
 * they are sent per event but capped, because ten toasts at once is a screen nobody reads.
 */

import { notifyDesktop, type DesktopSetup } from './desktop'
import { desktopText, peerMessage } from './notify-text'
import { sendToPeer } from './peer-client'
import { subscribersOf, type Subscription } from './subscriptions'
import type { SessionEvent } from './event-types'
import { readPreferences } from '../preferences'

/** The key a session's mute is stored under — the web's `sessionIdentityKey`, so one mute holds
 *  across the dashboard, the CLI and this producer (and survives a reopen). */
export function eventMuteKey(e: Pick<SessionEvent, 'id' | 'conversationId'>): string {
  return e.conversationId ?? e.id
}

/** The muted keys, read fresh (a mute made a second ago must apply to the next batch). A failed
 *  read means NOTHING is muted: failing toward silence would hide a session that needs someone. */
export async function readMutedKeys(): Promise<ReadonlySet<string>> {
  try { return new Set((await readPreferences()).mutedSessions ?? []) } catch { return new Set() }
}

/** How many toasts one batch may raise. Beyond this the last one says how many were folded in. */
const MAX_TOASTS_PER_BATCH = 3

export interface DeliveryReport {
  /** One line per attempt, already a sentence, for the command and the log to print. */
  lines: string[]
  peersReached: number
  peersFailed: number
  toastsShown: number
  toastsFailed: number
}

export const EMPTY_REPORT: DeliveryReport = {
  lines: [], peersReached: 0, peersFailed: 0, toastsShown: 0, toastsFailed: 0,
}

/**
 * Deliver a batch.
 *
 * `desktop` is passed in rather than probed here so a long-running producer probes the filesystem
 * once at startup instead of on every poll.
 */
export async function deliver(o: {
  events: readonly SessionEvent[]
  subscriptions: readonly Subscription[]
  desktop?: DesktopSetup
  /** Sessions whose notifications are muted (`eventMuteKey`). A mute removes the INTERRUPTION — the
   *  toast and the peer message — and nothing else: the event is already in the inbox by now. */
  muted?: ReadonlySet<string>
}): Promise<DeliveryReport> {
  const report: DeliveryReport = { ...EMPTY_REPORT, lines: [] }
  if (o.events.length === 0 || o.subscriptions.length === 0) return report

  // Which events each subscription wants, resolved once for the whole batch.
  const wanted = new Map<string, SessionEvent[]>()
  for (const sub of o.subscriptions) wanted.set(sub.id, [])
  for (const e of o.events) {
    if (o.muted?.has(eventMuteKey(e))) continue
    for (const sub of subscribersOf(o.subscriptions, e)) wanted.get(sub.id)!.push(e)
  }

  // --- the assistants -------------------------------------------------------
  for (const sub of o.subscriptions) {
    const mine = wanted.get(sub.id) ?? []
    if (sub.notify === undefined || mine.length === 0) continue
    const r = await sendToPeer(sub.notify, peerMessage(mine))
    if (r.ok) {
      report.peersReached++
      report.lines.push(`notified ${r.name ?? sub.notify} (pid ${r.pid}) — ${mine.length} event${mine.length > 1 ? 's' : ''} [${sub.id}]`)
    } else {
      report.peersFailed++
      // Not an error the caller has to handle: the event is durable. It IS something the user must
      // be told, which is what this line is.
      report.lines.push(`not delivered to "${sub.notify}" [${sub.id}]: ${r.message}`)
    }
  }

  // --- the person -----------------------------------------------------------
  // An event wanted by two desktop subscriptions is one toast, not two: the person is one person.
  const toast: SessionEvent[] = []
  for (const sub of o.subscriptions) {
    if (!sub.desktop) continue
    for (const e of wanted.get(sub.id) ?? []) if (!toast.includes(e)) toast.push(e)
  }

  const shown = toast.slice(0, MAX_TOASTS_PER_BATCH)
  const folded = toast.length - shown.length
  for (const [i, e] of shown.entries()) {
    const text = desktopText(e)
    const last = i === shown.length - 1
    const r = await notifyDesktop(
      last && folded > 0 ? { ...text, body: `${text.body} · and ${folded} more` } : text,
      e.cwd,
      o.desktop,
    )
    if (r.ok) {
      report.toastsShown++
    } else {
      report.toastsFailed++
      report.lines.push(`desktop notification failed (${r.channel}): ${r.message}`)
    }
  }
  if (report.toastsShown > 0) {
    report.lines.push(`desktop: ${report.toastsShown} notification${report.toastsShown > 1 ? 's' : ''}${folded > 0 ? ` (${folded} folded in)` : ''}`)
  }

  return report
}
