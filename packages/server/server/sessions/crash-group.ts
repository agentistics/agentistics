/**
 * crash-group.ts — PURE. Which sessions FELL TOGETHER, so all of them can be picked back up at once.
 *
 * A reboot, an OOM kill or a `tmux kill-server` takes the whole backend at once: every managed
 * session reconciles to `lost` in the same instant, keeping its name, its note and its task. Getting
 * them all back is one gesture, and this decides what "them all" means.
 *
 * ## The hard part is not the grouping, it is the garbage
 *
 * A registry that keeps a row for everything it ever started will happily hand you fifty `lost`
 * sessions, of which three actually fell — the other forty-seven were over days ago. A group like
 * that is a list of everything that has ever existed, and it cannot be reopened without reading
 * every row first, which is the whole of the work this is meant to remove.
 *
 * So membership needs evidence that a session was ALIVE when the machine went down, and no such
 * evidence existed: `createdAt` says when it started (a session opened three weeks ago and abandoned
 * has one just the same), and `BackendSession.lastActivityMs` only exists for a session the backend
 * still knows about — which is precisely not the case for one that fell. The registry therefore
 * records `lastSeenMs`, stamped when a session is created and refreshed by the poller's heartbeat.
 *
 * The heartbeat writes ONE timestamp for EVERY session alive at that moment, in a single write. That
 * is what makes the clustering exact rather than fuzzy: sessions that died together do not merely
 * have nearby `lastSeenMs`, they have the same one. The window below exists only to absorb the gap
 * between a session created since the last heartbeat (stamped at creation) and its older siblings
 * (stamped at the heartbeat), which is at most one interval — hence the invariant that the window is
 * wider than the heartbeat, asserted in the tests.
 *
 * ## Which way this errs, and why
 *
 * Two errors are possible, and they do not cost the same:
 *
 *  - **Admitting garbage** makes the group useless. It is the failure that was asked for by name,
 *    and it is silent: a group of forty rows looks exactly like a correct group of forty rows.
 *  - **Leaving out a session that really fell** costs one keypress. The row is still on the screen,
 *    still named, and still carries its own `Reopen` verb — which is what recovers it today.
 *
 * So every rule here errs toward EXCLUDING. In particular there is no fallback when `lastSeenMs` is
 * absent: a registry written by an older build, or a row this process never once saw alive, is not
 * in the group. It will join the next one, because the heartbeat stamps it as soon as it is seen.
 *
 * ## What is deliberately NOT a rule
 *
 *  - **No minimum size.** One session open when the laptop died is one session that fell, and the
 *    heading states the count and the time, so a group of one claims nothing a group of six does not.
 *  - **No maximum age.** A fall from three days ago that was never picked up is still the sessions
 *    that fell. The UI says WHEN, so "three days ago" is never mistaken for "just now".
 *  - **No requirement that the conversation be resolvable.** That is `planTaskReopen`'s business, and
 *    it already reports an unresolvable row as skipped AND counted. Filtering here instead would make
 *    the group quietly smaller than the fall it describes.
 */

import type { ManagedSession } from './types'

/**
 * How often the poller stamps every live session's `lastSeenMs`.
 *
 * Sixty seconds, and the number is a disk-write budget rather than a precision one: the poll runs
 * every five seconds over the whole fleet, and rewriting `managed-sessions.json` on every tick would
 * be twelve writes a minute for a fact that is only ever read at this granularity.
 */
export const HEARTBEAT_MS = 60_000

/**
 * How far apart two `lastSeenMs` values may be and still describe ONE fall.
 *
 * Twice the heartbeat: the widest genuine spread is one interval (a session created just after the
 * last heartbeat carries its creation stamp while its siblings carry the heartbeat's), and doubling
 * it leaves room for a poll that ran late without opening the door to a session that stopped being
 * alive minutes earlier.
 */
export const CRASH_WINDOW_MS = 2 * HEARTBEAT_MS

export interface CrashGroup {
  /** When the fall happened, as the newest evidence of life among its members. */
  atMs: number
  /** The registry rows that fell, in registry order. */
  entries: ManagedSession[]
}

export function planCrashGroup(o: {
  entries: readonly ManagedSession[]
  /**
   * Every id the backend still knows about — RUNNING OR EXITED.
   *
   * Exited counts as known: tmux keeps a finished session listable (`remain-on-exit`), so a command
   * that ended on its own is still something the backend can name. Only a session the backend has no
   * record of at all is one the machine took, which is the event this describes.
   */
  backendIds: ReadonlySet<string>
  windowMs?: number
}): CrashGroup | null {
  const window = o.windowMs ?? CRASH_WINDOW_MS

  const candidates = o.entries.filter(e => {
    // A kill OR an observed harness exit is a recorded end. It is never a fall.
    if (e.endedAt) return false
    // The backend still has it: it is running, or it exited on its own. Either way nothing took it.
    if (o.backendIds.has(e.id)) return false
    // No evidence it was ever alive under a build that records evidence. Excluded rather than
    // guessed at from `createdAt`, which says nothing about whether it was still open.
    return typeof e.lastSeenMs === 'number' && Number.isFinite(e.lastSeenMs)
  })
  if (candidates.length === 0) return null

  // The LAST fall, not every fall. A machine that crashed twice has two clusters, and the older one
  // is a different event — offering both under one heading would be the garbage problem again, one
  // level up.
  const atMs = candidates.reduce((n, e) => Math.max(n, e.lastSeenMs!), 0)
  const entries = candidates.filter(e => e.lastSeenMs! >= atMs - window)
  return { atMs, entries }
}

/**
 * How many rows the "start these again?" offer will NAME.
 *
 * A list read under one question, so it is bounded for the same reason the closed block is: a modal
 * listing forty rows is not an offer, it is a wall. What it cannot show, the caller counts.
 */
export const OFFER_LIMIT = 8

/** One fallen row, reduced to what an offer has to show to be decidable. */
export interface FellOffer {
  entry: ManagedSession
  /** The user's own name when there is one, else the conversation's. */
  label: string
  resumeId: string
  /** When it started, epoch ms — absent when the registry's timestamp is unreadable. */
  startedMs?: number
}

/**
 * The fall as an OFFER — PURE, and deliberately narrower than the fall itself by exactly one rule.
 *
 * The SELECTION is `planCrashGroup` and stays there. This is the presentation question on top of
 * it: which of those rows can be put in a list someone clicks. A row whose conversation does not
 * resolve is dropped, because such a row is a button that fails — and it is dropped HERE rather
 * than in the selection, because it is still a session that fell. `reopenEntries` counts it as
 * skipped, which is the honest report; leaving it out of `planCrashGroup` would make the count on
 * the summary row quietly smaller than the event it describes.
 *
 * Ordered newest first: this is read under one question, and the sessions somebody was in the
 * middle of are the recent ones.
 *
 * A conversation is CLAIMED once. The harness+directory fallback answers with the first
 * conversation in a directory, so four fallen rows in one repository would otherwise be offered
 * four copies of one conversation — a bug this project has already shipped once.
 */
export function planFellOffer(o: {
  entries: readonly ManagedSession[]
  /** The conversation this entry would reopen, or `null` when none resolves. */
  conversationFor: (entry: ManagedSession) => { sessionId: string; title: string } | null
  limit?: number
}): FellOffer[] {
  const out: FellOffer[] = []
  for (const entry of o.entries) {
    const conv = o.conversationFor(entry)
    if (!conv) continue
    const started = Date.parse(entry.createdAt)
    out.push({
      entry,
      label: entry.label ?? conv.title,
      resumeId: conv.sessionId,
      ...(Number.isFinite(started) ? { startedMs: started } : {}),
    })
  }
  return out
    .sort((a, b) => (b.startedMs ?? 0) - (a.startedMs ?? 0))
    .slice(0, o.limit ?? OFFER_LIMIT)
}
