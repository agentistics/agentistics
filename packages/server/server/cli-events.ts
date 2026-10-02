/**
 * cli-events.ts — `agentop events watch | unwatch | status | tail | run | emit | test`.
 *
 * The I/O half of the event channel. Every DECISION it makes is already made by a pure module:
 * `events-parse.ts` says what the words mean, `subscriptions.ts` says who hears what,
 * `notify-plan.ts` says which desktop channel this machine has, `peer-target.ts` says whether a
 * named Claude session can be reached, `notify-text.ts` says what a notification is allowed to say.
 * This file reads files, spawns things, and reports.
 *
 * Two rules it exists to honour, both of them about not lying:
 *
 *  1. **A delivery that did not happen is reported as not having happened.** A `--notify` naming a
 *     session that is not running leaves the event in the inbox and SAYS the session was not
 *     reached. There is no path here that prints a success it did not observe.
 *  2. **"Nobody is watching" is a state with a name.** `status` reports the producer as running,
 *     stale or absent, and names the desktop channel in use — because an event channel that
 *     silently has no producer is indistinguishable from a quiet machine.
 */

import { createEventStore } from './events/event-store'
import { EMPTY_CURSOR, type EventCursor } from './events/event-rotate'
import { EVENT_VERSION, type EventKind, type SessionEvent } from './events/event-types'
import { parseEventsArgs, type EventsCommand, type TailOptions, type WatchOptions } from './events/events-parse'
import { desktopSetup } from './events/desktop'
import { deliver, readMutedKeys } from './events/notifier'
import { desktopText, eventHeadline, peerMessage } from './events/notify-text'
import { listLivePeers, resolvePeer, sendToPeer } from './events/peer-client'
import { createHeartbeatWriter, producerState } from './events/producer-status'
import { createHostProducer } from './events/producer'
import {
  addSubscription, clearSubscriptions, newSubscriptionId, removeSubscription, type Subscription,
} from './events/subscriptions'
import {
  SUBSCRIPTIONS_FILE, readSubscriptionStore, writeSubscriptionStore,
} from './events/subscription-store'

const USAGE = `Usage:
  agentop events watch   [--task <name>] [--session <id|label>] [--on <states>]
                         [--notify <claude-session>] [--desktop] [--note <text>] [--json]
  agentop events unwatch <id> | --all
  agentop events status  [--json]
  agentop events tail    [-n <count>] [--since <offset:seq>] [--task <name>] [--on <states>]
                         [--follow] [--json]
  agentop events run     [--once]
  agentop events test    [--notify <claude-session>] [--desktop]

Know what your sessions are doing without watching them.

  A transition — a session starting to wait, blocking on a permission prompt, or exiting — is
  written to an append-only inbox (~/.agentistics/events.jsonl) and, if something subscribed,
  delivered to a Claude Code session over its own messaging socket and/or to your desktop.

  watch    register a subscription. It is a FILE, not a process: whichever producer is up
           delivers it, so it survives a reboot and does not need you to keep a terminal open.
  tail     read the inbox. --since takes the cursor --json prints, so a session that was not
           running reads exactly what it missed.
  status   who is producing, what is subscribed, which desktop channel this machine has.
  run      run the producer in the foreground (when you do not run \`agentop server\`).
  test     deliver a probe through the real channels, so a broken one is found before it matters.

States for --on: working, waiting, waiting-approval, exited, turn-end
                 (default: waiting, waiting-approval, exited)

Two sources feed the inbox. agentop's own five-second monitor reads the SCREEN, so it works for
every harness it manages; a Claude Code \`Stop\` hook (\`agentop hooks install\`) reports the end of
a Claude turn exactly and instantly. The same turn seen by both is written once.

Events report facts. Nothing in this channel answers a permission prompt, and a session blocked on
one is reported as waiting on a person.`

export async function runEvents(argv: string[]): Promise<number> {
  const cmd = parseEventsArgs(argv)
  switch (cmd.kind) {
    case 'help': console.log(USAGE); return 0
    case 'error': console.error(cmd.message); console.error(`\n${USAGE}`); return 1
    case 'watch': return watch(cmd.options)
    case 'unwatch': return unwatch(cmd)
    case 'status': return status(cmd.json)
    case 'tail': return tail(cmd.options)
    case 'run': return run(cmd.once)
    case 'emit': return emit()
    case 'test': return test(cmd)
  }
}

// ---------------------------------------------------------------------------
// watch / unwatch
// ---------------------------------------------------------------------------

async function watch(o: WatchOptions): Promise<number> {
  // A `--notify` naming a session nobody can reach is refused HERE rather than at delivery time: a
  // subscription that can never deliver is a subscription the user believes is working.
  if (o.notify !== undefined) {
    const found = await resolvePeer(o.notify)
    if (!found.ok && found.code === 'no-match') {
      console.error(found.message)
      await printLivePeers()
      return 1
    }
    if (!found.ok && found.code === 'ambiguous') {
      console.error(found.message)
      for (const c of found.candidates) console.error(`  ${c}`)
      return 1
    }
    // `not-live` is NOT refused: registering a subscription for a session that is currently
    // restarting is a reasonable thing to do, and the events wait in the inbox regardless. It is
    // said out loud instead.
    if (!found.ok) console.log(`note: ${found.message}`)
  }

  const store = await readSubscriptionStore()
  const sub: Subscription = {
    id: newSubscriptionId(store.subscriptions),
    createdAt: new Date().toISOString(),
    ...(o.task !== undefined ? { task: o.task } : {}),
    ...(o.session !== undefined ? { session: o.session } : {}),
    kinds: o.kinds,
    ...(o.notify !== undefined ? { notify: o.notify } : {}),
    desktop: o.desktop,
    ...(o.note !== undefined ? { note: o.note } : {}),
  }
  await writeSubscriptionStore(addSubscription(store, sub))

  if (o.json) {
    console.log(JSON.stringify(sub, null, 2))
    return 0
  }

  console.log(`subscribed  ${sub.id}`)
  console.log(`  on        ${sub.kinds.join(', ')}`)
  console.log(`  scope     ${describeScope(sub)}`)
  console.log(`  delivery  ${describeDelivery(sub)}`)
  console.log(`  stored in ${SUBSCRIPTIONS_FILE}`)

  // The one thing that makes this subscription useless is nothing producing events, so it is
  // checked at the moment of subscribing rather than left for the user to discover in silence.
  const p = await producerState()
  if (p.state !== 'running') {
    console.log('')
    console.log(p.state === 'stale'
      ? `warning: the last producer (pid ${p.heartbeat.pid}) is gone, so nothing is watching right now.`
      : 'warning: nothing is producing events right now.')
    console.log('  start one with `agentop server` (the daemon carries it) or `agentop events run`.')
  }
  return 0
}

async function unwatch(cmd: Extract<EventsCommand, { kind: 'unwatch' }>): Promise<number> {
  const store = await readSubscriptionStore()
  const r = cmd.all ? clearSubscriptions(store) : removeSubscription(store, cmd.id!)
  if (r.removed.length === 0) {
    console.error(cmd.all
      ? 'There are no subscriptions to remove.'
      : `No subscription "${cmd.id}". \`agentop events status\` lists them.`)
    return 1
  }
  await writeSubscriptionStore(r.store)
  for (const s of r.removed) console.log(`removed  ${s.id}  (${describeScope(s)} → ${describeDelivery(s)})`)
  return 0
}

const describeScope = (s: Subscription): string => {
  const parts = [
    s.task !== undefined ? `task "${s.task}"` : '',
    s.session !== undefined ? `session "${s.session}"` : '',
  ].filter(p => p !== '')
  return parts.length > 0 ? parts.join(', ') : 'every session'
}

const describeDelivery = (s: Subscription): string => {
  const parts = [s.notify !== undefined ? `notify "${s.notify}"` : '', s.desktop ? 'desktop' : '']
    .filter(p => p !== '')
  // A subscription with no delivery still shapes what the producer RECORDS, so it is described as
  // what it is rather than as nothing.
  return parts.length > 0 ? parts.join(' + ') : 'inbox only'
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function status(json: boolean): Promise<number> {
  const [state, store, info, setup, peers] = await Promise.all([
    producerState(),
    readSubscriptionStore(),
    createEventStore().info(),
    desktopSetup(),
    listLivePeers(),
  ])

  if (json) {
    console.log(JSON.stringify({
      producer: state,
      subscriptions: store.subscriptions,
      inbox: info,
      desktop: setup.decision,
      livePeers: peers.map(p => ({ pid: p.pid, name: p.name, cwd: p.cwd })),
      eventVersion: EVENT_VERSION,
    }, null, 2))
    return 0
  }

  console.log(`producer  ${state.state === 'running'
    ? `running   pid ${state.heartbeat.pid} (${state.heartbeat.host}), since ${state.heartbeat.startedAt}`
    : state.state === 'stale'
      ? `NOT RUNNING — the last one (pid ${state.heartbeat.pid}, ${state.heartbeat.host}) is gone. Nothing is watching.`
      : 'NOT RUNNING — nothing is watching. Start `agentop server`, or `agentop events run`.'}`)
  if (state.state === 'running' && state.heartbeat.unavailable) {
    console.log(`          but it cannot watch anything here: ${state.heartbeat.unavailable}`)
  }

  console.log(`inbox     ${info.file}  ${fmtBytes(info.bytes)}${info.previousBytes > 0 ? ` (+ ${fmtBytes(info.previousBytes)} rotated)` : ''}, last seq ${info.seq}`)
  console.log(`desktop   ${setup.decision.channel}  — ${setup.decision.reason}`)

  console.log(`\nsubscriptions (${store.subscriptions.length})`)
  if (store.subscriptions.length === 0) {
    console.log('  none — `agentop events watch --desktop` is the smallest useful one.')
  }
  for (const s of store.subscriptions) {
    console.log(`  ${s.id}  ${describeScope(s)}`)
    console.log(`      on ${s.kinds.join(', ')} → ${describeDelivery(s)}${s.note ? `  · ${s.note}` : ''}`)
  }

  console.log(`\nclaude code sessions reachable now (${peers.length})`)
  if (peers.length === 0) console.log('  none running')
  for (const p of peers) console.log(`  ${p.name ?? '(unnamed)'}  pid ${p.pid}  ${p.cwd ?? ''}`)
  return 0
}

const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

async function printLivePeers(): Promise<void> {
  const peers = await listLivePeers()
  if (peers.length === 0) {
    console.error('No Claude Code session is running on this machine right now.')
    return
  }
  console.error('Running Claude Code sessions:')
  for (const p of peers) console.error(`  ${p.name ?? '(unnamed)'}  pid ${p.pid}  ${p.cwd ?? ''}`)
}

// ---------------------------------------------------------------------------
// tail
// ---------------------------------------------------------------------------

function wanted(e: SessionEvent, o: TailOptions): boolean {
  if (o.task !== undefined && e.task !== o.task) return false
  if (o.kinds && !o.kinds.includes(e.kind as EventKind)) return false
  return true
}

async function tail(o: TailOptions): Promise<number> {
  const store = createEventStore()
  let cursor: EventCursor = o.since !== undefined
    ? { offset: o.since, seq: o.sinceSeq ?? 0 }
    : EMPTY_CURSOR

  const read = o.since !== undefined
    ? await store.since(cursor)
    : { ...(await store.recent(o.count)), rotated: false }
  cursor = read.cursor

  const shown = read.events.filter(e => wanted(e, o))
  printEvents(shown, o.json, read.rotated, read.unreadable, cursor)

  if (!o.follow) return 0

  // Following is a poll of the file, not a filesystem watch: the inbox is appended to by more than
  // one process and a missed notification here costs a delay, not an event.
  const stop = new Promise<void>(resolve => {
    process.on('SIGINT', () => resolve())
    process.on('SIGTERM', () => resolve())
  })
  let running = true
  void stop.then(() => { running = false })
  while (running) {
    await new Promise(r => setTimeout(r, 1_000))
    if (!running) break
    const next = await store.since(cursor)
    cursor = next.cursor
    const fresh = next.events.filter(e => wanted(e, o))
    if (fresh.length > 0 || next.rotated) printEvents(fresh, o.json, next.rotated, 0, cursor)
  }
  return 0
}

function printEvents(
  events: readonly SessionEvent[],
  json: boolean,
  rotated: boolean,
  unreadable: number,
  cursor: EventCursor,
): void {
  if (json) {
    console.log(JSON.stringify({
      events,
      cursor: `${cursor.offset}:${cursor.seq}`,
      ...(rotated ? { rotated: true } : {}),
      ...(unreadable > 0 ? { unreadable } : {}),
    }, null, 2))
    return
  }
  if (rotated) {
    console.log('note: the inbox was rotated since that cursor — some older events are gone. Reading from the start of the current file.')
  }
  if (unreadable > 0) {
    console.log(`note: ${unreadable} line${unreadable > 1 ? 's' : ''} in the inbox cannot be read by this version of agentop.`)
  }
  if (events.length === 0) {
    console.log('no events')
    console.log(`cursor ${cursor.offset}:${cursor.seq}`)
    return
  }
  for (const e of events) {
    console.log(`${e.at}  ${e.source === 'hook' ? 'hook' : 'poll'}  ${eventHeadline(e)}`)
    console.log(`  ${e.cwd}`)
    for (const l of (e.lines ?? []).slice(-3)) console.log(`  | ${l}`)
  }
  console.log(`cursor ${cursor.offset}:${cursor.seq}`)
}

// ---------------------------------------------------------------------------
// run — the producer in the foreground
// ---------------------------------------------------------------------------

async function run(once: boolean): Promise<number> {
  const made = await createHostProducer({ onError: m => console.error(`[events] ${m}`) })
  if ('unavailable' in made) {
    console.error(`Cannot watch sessions here: ${made.unavailable}`)
    return 1
  }
  const beat = createHeartbeatWriter({ host: 'foreground' })

  if (once) {
    // One tick can only SEED — see `producer.ts`. Said plainly rather than letting someone conclude
    // that a single run reports nothing because nothing happened.
    await made.producer.tick()
    console.log('seeded: recorded where every session is now. A transition needs a second look, so')
    console.log('`--once` never reports one. Run without it to watch.')
    return 0
  }

  const { SESSION_POLL_MS } = await import('./sessions/sessions-host')
  await beat.beat()
  console.log(`[events] watching — pid ${process.pid}, every ${SESSION_POLL_MS}ms. ctrl-c to stop.`)

  let running = true
  const stop = (): void => { running = false; made.producer.stop() }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  while (running) {
    const t = await made.producer.tick().catch(e => {
      // A bad tick is reported and the loop continues: a producer that dies on one failed poll is
      // a producer that is not running at the moment it matters.
      console.error(`[events] ${e instanceof Error ? e.message : String(e)}`)
      return null
    })
    await beat.beat(t?.unavailable)
    for (const e of t?.written ?? []) console.log(`${e.at}  ${eventHeadline(e)}`)
    for (const l of t?.delivery.lines ?? []) console.log(`  ${l}`)
    if (!running) break
    await new Promise(r => setTimeout(r, SESSION_POLL_MS))
  }

  await beat.clear()
  console.log('[events] stopped.')
  return 0
}

// ---------------------------------------------------------------------------
// emit — what the Claude Code Stop hook runs
// ---------------------------------------------------------------------------

/**
 * The hook body. Reads the Claude Code hook payload on stdin and writes ONE event.
 *
 * Every failure path is silence with exit 0. This runs on the critical path of a Claude session
 * finishing a turn; a hook that errors or prints a stack trace is worse in every case than one that
 * says nothing — the same rule `agentop hooks context` follows, for the same reason.
 */
async function emit(): Promise<number> {
  try {
    const raw = await new Response(Bun.stdin.stream()).text()
    if (raw.trim() === '') return 0
    const payload = JSON.parse(raw) as Record<string, unknown>

    const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
    const conversationId = typeof payload.session_id === 'string' ? payload.session_id : undefined

    // What agentop knows about this directory: the task and label the user gave the session. Read
    // straight from the registry rather than through the poller — a hook must not spawn tmux.
    const { readRegistry } = await import('./sessions/registry')
    const managed = (await readRegistry().catch(() => []))
      .filter(m => !m.endedAt && m.harness === 'claude' && m.cwd === cwd)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]

    const event: SessionEvent = {
      v: EVENT_VERSION,
      seq: 0,
      at: new Date().toISOString(),
      source: 'hook',
      kind: 'turn-end',
      id: managed?.id ?? `claude:${conversationId ?? cwd}`,
      harness: 'claude',
      cwd,
      ...(managed?.task ? { task: managed.task } : {}),
      ...(managed?.label ? { label: managed.label } : {}),
      ...(conversationId ? { conversationId } : {}),
    }

    const written = await createEventStore().append([event])
    const subs = (await readSubscriptionStore()).subscriptions
    if (subs.length > 0) await deliver({ events: written, subscriptions: subs, muted: await readMutedKeys() })
  } catch {
    // Deliberately silent — see above.
  }
  return 0
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

async function test(cmd: Extract<EventsCommand, { kind: 'test' }>): Promise<number> {
  const probe: SessionEvent = {
    v: EVENT_VERSION,
    seq: 0,
    at: new Date().toISOString(),
    source: 'poll',
    kind: 'waiting',
    id: 'probe',
    harness: 'claude',
    cwd: process.cwd(),
    label: 'agentop events test',
    lines: ['This is a test notification from `agentop events test`.'],
  }

  let failed = false

  if (cmd.notify !== undefined) {
    const r = await sendToPeer(cmd.notify, peerMessage([probe]))
    if (r.ok) console.log(`notify    delivered to ${r.name ?? cmd.notify} (pid ${r.pid})`)
    else { console.error(`notify    NOT delivered: ${r.message}`); failed = true }
  }

  if (cmd.desktop) {
    const setup = await desktopSetup()
    console.log(`desktop   channel: ${setup.decision.channel} — ${setup.decision.reason}`)
    const r = await deliver({
      events: [probe],
      subscriptions: [{ id: 'probe', createdAt: probe.at, kinds: ['waiting'], desktop: true }],
      desktop: setup,
    })
    if (r.toastsShown > 0) console.log('desktop   shown')
    else {
      console.error(`desktop   NOT shown${r.lines.length > 0 ? `: ${r.lines.join('; ')}` : ` (${setup.decision.reason})`}`)
      failed = true
    }
  }

  // The probe is deliberately NOT written to the inbox: a test event in the real inbox is a fact
  // that never happened, and the next reader would report it as one.
  console.log('')
  console.log(desktopText(probe).title)
  console.log(desktopText(probe).body)
  return failed ? 1 : 0
}
