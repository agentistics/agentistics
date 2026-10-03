/**
 * native.ts — H17: a NATIVE Agentistics session's own state changes, into the SAME event channel
 * `agentop events` reads and the same delivery (desktop toast, peers) the fleet's poll uses.
 *
 * A native session has no screen, so the poll cannot see it. The engine reports each change itself
 * (`EngineHost.events.nativeSession`, engine-api 1.7, optional):
 * - `waiting-approval`: the runtime asked the person (a tool call needs an answer);
 * - `waiting`: a run ended and the session waits for the next message;
 * - `working`: a run started.
 *
 * The event carries facts only (the channel's rule, `event-types.ts`): which session, where, which
 * task, from what to what. No question text, no tool input, no conversation. It is recorded only when
 * a subscription wants its kind, written to the inbox, and delivered exactly as the poll's events are.
 * It is written to the inbox like every other event, and delivered where a subscription wants it.
 * It never throws: a notification that fails costs the person a toast, never the session anything.
 */
import { EVENT_VERSION, type EventKind, type SessionEvent } from './event-types'
import type { SessionActivity } from '../sessions/types'
import type { EventStore } from './event-store'
import type { Subscription } from './subscriptions'
import type { DeliveryReport } from './notifier'

export interface NativeSessionEventInput {
  sessionId: string
  kind: 'working' | 'waiting' | 'waiting-approval'
  /** The state before, when the engine knows it. */
  from?: 'working' | 'waiting' | 'waiting-approval'
  cwd: string
  label?: string
  taskId?: string
  /** ISO. */
  at: string
}

/** PURE. The channel's event for a native session's change; `null` when no subscription wants it. */
export function nativeEvent(e: NativeSessionEventInput, wanted: readonly EventKind[] | undefined): SessionEvent | null {
  if (wanted && !wanted.includes(e.kind)) return null
  if (e.from === e.kind) return null
  return {
    v: EVENT_VERSION,
    seq: 0,
    at: e.at,
    source: 'native',
    kind: e.kind,
    ...(e.from ? { from: e.from as SessionActivity } : {}),
    id: `native:${e.sessionId}`,
    cwd: e.cwd,
    ...(e.taskId ? { task: e.taskId } : {}),
    ...(e.label ? { label: e.label } : {}),
  }
}

export interface NativeEventDeps {
  readSubscriptions: () => Promise<Subscription[]>
  store: EventStore
  deliver: (o: { events: readonly SessionEvent[]; subscriptions: readonly Subscription[]; muted?: ReadonlySet<string> }) => Promise<DeliveryReport>
  readMuted: () => Promise<ReadonlySet<string>>
}

/** Record and deliver one native change. Never throws; the written event (or null) is returned. */
export async function recordNativeEvent(e: NativeSessionEventInput, d: NativeEventDeps): Promise<SessionEvent | null> {
  try {
    // Recorded even with no subscription, as the poll's events are: the inbox is what an
    // orchestrating session reads. Delivery (a toast, a peer) then happens only where subscribed.
    const subs = await d.readSubscriptions().catch(() => [] as Subscription[])
    const { kindsToRecord } = await import('./subscriptions')
    const ev = nativeEvent(e, kindsToRecord(subs))
    if (!ev) return null
    const [written] = await d.store.append([ev])
    if (!written) return null
    // Delivered apart: a toast that fails does not unwrite what the inbox already holds.
    try {
      await d.deliver({ events: [written], subscriptions: subs, muted: await d.readMuted() })
    } catch { /* the event is in the inbox; the interruption is what was lost */ }
    return written
  } catch {
    return null
  }
}

/** The real dependencies: the inbox, the subscriptions, the notifier. Built per call, cheaply. */
export async function liveNativeEventDeps(): Promise<NativeEventDeps> {
  const [{ createEventStore }, { readSubscriptions }, { deliver, readMutedKeys }, { desktopSetup }] = await Promise.all([
    import('./event-store'), import('./subscription-store'), import('./notifier'), import('./desktop'),
  ])
  let desktop: Awaited<ReturnType<typeof desktopSetup>> | undefined
  return {
    readSubscriptions,
    store: createEventStore(),
    readMuted: readMutedKeys,
    deliver: async o => {
      if (desktop === undefined && o.subscriptions.some(s => s.desktop)) desktop = await desktopSetup()
      return deliver({ ...o, ...(desktop ? { desktop } : {}) })
    },
  }
}
