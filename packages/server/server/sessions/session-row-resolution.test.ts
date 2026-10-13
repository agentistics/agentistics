import { expect, test } from 'bun:test'
import type { StartHost } from '../cli-start'
import { cliStrings } from '../cli-i18n'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { createChatRowHost, createSessionRowCache, MAX_ROW_ENTRIES, resolveSessionRow, shareSessionRowCache } from './session-row-resolution'
import { ROW_TTL_MS as CHAT_ROW_TTL_MS } from './chat-stream'
import { readSessionChat } from './chat-web'
import {
  listSessionArtifacts, readConversationFacts, readFleetArtifactMedia,
  readFleetPullRequests, readFleetSkills,
} from './fleet-web'

function fixture(rows = [{ id: 'selected', cwd: '/nonexistent/open-burst', harness: 'quokka', state: 'working' }]) {
  let calls = 0
  const host = { sessions: async () => {
    calls++
    await Promise.resolve()
    return { sessions: rows }
  } } as unknown as StartHost
  return { host, calls: () => calls }
}

function openBurst(host: StartHost, ref = 'selected') {
  return Promise.all([
    readSessionChat(host, 'en', ref),
    readFleetSkills('en', ref, host),
    readFleetPullRequests('en', ref, host),
    readConversationFacts('en', ref, host),
    listSessionArtifacts(host, 'en', ref),
  ])
}

test('the five open handlers preserve their payloads and reduce six fleet reads to one', async () => {
  const before = fixture()
  // The old lookup path: every handler walks the fleet, including artifacts' nested chat read.
  shareSessionRowCache(before.host, {
    clear() {},
    async resolve(host, ref, conversationRef) {
      const fleet = await host.sessions!()
      return fleet.sessions.find(row => row.id === ref || (conversationRef && row.conversationId === ref))
    },
  })
  const original = await openBurst(before.host)
  expect(before.calls()).toBe(6)

  const after = fixture()
  const cached = await openBurst(after.host)
  expect(after.calls()).toBe(1)
  expect(cached).toEqual(original)
})

test('N concurrent reads share the pending promise even past the TTL', async () => {
  let now = 0
  const cache = createSessionRowCache(() => now)
  let finish!: (value: { sessions: ControlSession[] }) => void
  let calls = 0
  const host = { sessions: () => { calls++; return new Promise<{ sessions: ControlSession[] }>(resolve => { finish = resolve }) } } as unknown as StartHost
  const first = cache.resolve(host, 'selected')
  await Promise.resolve()
  now = 5_000
  const rest = Array.from({ length: 20 }, () => cache.resolve(host, 'selected'))
  finish({ sessions: [{ id: 'selected', cwd: '/cold/cwd' } as ControlSession] })
  const rows = await Promise.all([first, ...rest])
  expect(calls).toBe(1)
  expect(rows.every(row => row === rows[0] && row?.cwd === '/cold/cwd')).toBe(true)
})

test('different references resolve independently and never return another session', async () => {
  const { host, calls } = fixture([
    { id: 'one', cwd: '/one', harness: '', state: 'working' },
    { id: 'two', cwd: '/two', harness: '', state: 'working' },
  ])
  const [one, two] = await Promise.all([resolveSessionRow(host, 'one'), resolveSessionRow(host, 'two')])
  expect(calls()).toBe(2)
  expect(one?.cwd).toBe('/one')
  expect(two?.cwd).toBe('/two')
})

test('a settled entry expires at two seconds and starts a new host read', async () => {
  let now = 0
  const cache = createSessionRowCache(() => now)
  const { host, calls } = fixture()
  await cache.resolve(host, 'selected')
  now = 1_999
  await cache.resolve(host, 'selected')
  expect(calls()).toBe(1)
  now = 2_000
  await cache.resolve(host, 'selected')
  expect(calls()).toBe(2)
})

test('an inherited chat-stream host shares its canonical host resolution', async () => {
  const en = fixture(), pt = fixture()
  const cache = createSessionRowCache()
  shareSessionRowCache(en.host, cache)
  shareSessionRowCache(pt.host, cache)
  const stream = Object.create(en.host) as StartHost
  await Promise.all([
    readSessionChat(stream, 'en', 'selected'),
    readFleetSkills('pt', 'selected', pt.host),
    listSessionArtifacts(en.host, 'en', 'selected'),
  ])
  expect(en.calls()).toBe(1)
  expect(pt.calls()).toBe(1)
})

test('fleet changes and explicit invalidation force a new walk', async () => {
  let revision: unknown = {}
  const cache = createSessionRowCache(Date.now, () => revision)
  const { host, calls } = fixture()
  await cache.resolve(host, 'selected')
  revision = {}
  await cache.resolve(host, 'selected')
  expect(calls()).toBe(2)
  cache.clear()
  await cache.resolve(host, 'selected')
  expect(calls()).toBe(3)
})

test('failed reads are evicted and may be retried', async () => {
  const { host, calls } = fixture()
  const sessions = host.sessions!
  let fail = true
  host.sessions = async () => {
    if (fail) { fail = false; throw new Error('walk failed') }
    return sessions.call(host)
  }
  await expect(resolveSessionRow(host, 'selected')).rejects.toThrow('walk failed')
  expect((await resolveSessionRow(host, 'selected'))?.id).toBe('selected')
  expect(calls()).toBe(1)
})

test('conversation aliases retain each handler\'s original lookup semantics', async () => {
  const { host, calls } = fixture()
  const sessions = host.sessions!
  host.sessions = async () => {
    const fleet = await sessions.call(host)
    fleet.sessions[0]!.conversationId = 'conversation'
    return fleet
  }
  const [strict, alias] = await Promise.all([
    resolveSessionRow(host, 'conversation'), resolveSessionRow(host, 'conversation', true),
  ])
  expect(strict).toBeUndefined()
  expect(alias?.id).toBe('selected')
  expect(calls()).toBe(1)
})

test('missing rows preserve payloads and the artifact 404', async () => {
  const { host, calls } = fixture()
  const [chat, skills, prs, facts, artifacts] = await openBurst(host, 'missing')
  expect(chat).toMatchObject({ turns: [], live: false, unavailable: 'This session is no longer in this machine’s list.' })
  expect(skills).toEqual({ skills: [], reason: 'This machine does not know that session.' })
  expect(prs).toEqual({ pulls: [], unavailable: 'no-repo', detail: 'This session has no recorded folder.' })
  expect(facts).toEqual({ unavailable: 'This session has no linked conversation yet.' })
  expect(artifacts).toEqual({ files: [] })
  expect(await readFleetArtifactMedia('en', 'missing', 'image.png', host)).toEqual({
    ok: false, status: 404,
    message: 'That session is not in this machine’s list, or has no recorded folder.',
  })
  expect(calls()).toBe(1)
})

test('EN and PT resolutions preserve the full localized row', async () => {
  const row = (lang: 'en' | 'pt'): ControlSession => {
    const s = cliStrings(lang)
    return {
      id: 'selected', title: 'Same title', cwd: '/same/cwd', harness: 'quokka',
      state: 'exited', stateLabel: `${s.sessState.exited} · ${s.sessBackground}`,
      background: true, actionable: true,
      conversationBlind: s.sessConversationLost('quokka'),
      chooseBlind: s.sessChooseBlind('quokka'),
      approvalBlind: s.sessApprovalBlind('quokka'), dirGone: s.sessDirGone,
    } as ControlSession
  }
  const enRow = row('en'), ptRow = row('pt')
  const en = { lang: 'en', sessions: async () => ({ sessions: [enRow] }) } as unknown as StartHost
  const pt = { lang: 'pt', sessions: async () => ({ sessions: [ptRow] }) } as unknown as StartHost
  const cache = createSessionRowCache()
  shareSessionRowCache(en, cache)
  shareSessionRowCache(pt, cache)
  expect(await resolveSessionRow(en, 'selected')).toEqual(enRow)
  expect(await resolveSessionRow(pt, 'selected')).toEqual(ptRow)
  expect(await resolveSessionRow(en, 'selected')).toEqual(enRow)
  const facts = await readConversationFacts('pt', 'selected', pt)
  expect(facts.unavailable).toBe(cliStrings('pt').sessConversationLost('quokka'))
})

test('independent hosts sharing a cache keep same-ref different-cwd rows isolated', async () => {
  const one = fixture([{ id: 'selected', cwd: '/one', harness: '', state: 'working' }])
  const two = fixture([{ id: 'selected', cwd: '/two', harness: '', state: 'working' }])
  Object.assign(one.host, { lang: 'en' })
  Object.assign(two.host, { lang: 'en' })
  const cache = createSessionRowCache()
  shareSessionRowCache(one.host, cache)
  shareSessionRowCache(two.host, cache)
  expect((await resolveSessionRow(one.host, 'selected'))?.cwd).toBe('/one')
  expect((await resolveSessionRow(two.host, 'selected'))?.cwd).toBe('/two')
  expect((await resolveSessionRow(one.host, 'selected'))?.cwd).toBe('/one')
  expect(one.calls()).toBe(1)
  expect(two.calls()).toBe(1)
})

test('the five-second chat wrapper cannot repopulate changed or removed rows after revision changes', async () => {
  let now = 0, revision = 0, calls = 0
  let rows = [{ id: 'selected', cwd: '/old', harness: 'quokka', state: 'working' }]
  const host = { lang: 'en', sessions: async () => { calls++; return { sessions: rows } } } as unknown as StartHost
  const cache = createSessionRowCache(() => now, () => revision)
  shareSessionRowCache(host, cache)
  const stream = createChatRowHost(host, CHAT_ROW_TTL_MS, () => now)
  const oldFleet = await stream.host.sessions!()
  expect((await resolveSessionRow(stream.host, 'selected'))?.cwd).toBe('/old')
  now = 2_001
  rows = [{ id: 'selected', cwd: '/new', harness: 'quokka', state: 'working' }]
  revision++
  expect(await stream.host.sessions!()).toBe(oldFleet) // The real wrapper still holds its 5 s memo.
  expect((await resolveSessionRow(stream.host, 'selected'))?.cwd).toBe('/new')
  expect((await resolveSessionRow(host, 'selected'))?.cwd).toBe('/new')
  now = 3_000
  rows = []
  revision++
  expect(await stream.host.sessions!()).toBe(oldFleet)
  await readSessionChat(stream.host, 'en', 'selected') // Non-fresh transcript-driven read wins the miss.
  expect(await readFleetArtifactMedia('en', 'selected', 'image.png', host)).toMatchObject({ ok: false, status: 404 })
  expect(await readFleetSkills('en', 'selected', host)).toEqual({ skills: [], reason: 'This machine does not know that session.' })
  expect(calls).toBe(4) // One wrapper prime plus one canonical walk per snapshot.
})

test('a fresh chat read invalidates an already-held shared row within both TTLs', async () => {
  let rows = [{ id: 'selected', cwd: '/old', harness: 'quokka', state: 'working' }]
  const host = { sessions: async () => ({ sessions: rows }) } as unknown as StartHost
  const stream = createChatRowHost(host)
  await stream.host.sessions!()
  expect((await resolveSessionRow(stream.host, 'selected'))?.cwd).toBe('/old')
  rows = [{ id: 'selected', cwd: '/new', harness: 'quokka', state: 'working' }]
  stream.fresh()
  expect((await resolveSessionRow(stream.host, 'selected'))?.cwd).toBe('/new')
  expect((await resolveSessionRow(host, 'selected'))?.cwd).toBe('/new')
})

test('unsettled fleet loads stay bounded across timeout and admission cycles until settlement', async () => {
  let calls = 0, active = 0
  let finish!: (value: { sessions: ControlSession[] }) => void
  // Retain the underlying promise outside the cache: caller deadlines never settle it.
  const fleet = new Promise<{ sessions: ControlSession[] }>(resolve => { finish = resolve })
  const host = { sessions: () => {
    calls++
    active++
    return fleet.finally(() => { active-- })
  } } as unknown as StartHost
  const timeoutMs = 100
  const cache = createSessionRowCache(Date.now, () => undefined, timeoutMs)
  const reads = Array.from({ length: MAX_ROW_ENTRIES + 10 }, (_, i) => cache.resolve(host, String(i)))
  const shared = cache.resolve(host, '0')
  const outcomes = Promise.allSettled([...reads, shared])
  await Promise.resolve()
  expect(cache.size).toBe(MAX_ROW_ENTRIES)
  expect(calls).toBe(MAX_ROW_ENTRIES)
  await expect(cache.resolve(host, 'over-cap')).rejects.toThrow('capacity exceeded')
  const results = await outcomes
  expect(results.slice(0, MAX_ROW_ENTRIES).every(r => r.status === 'rejected' && r.reason.message.includes('timed out'))).toBe(true)
  expect(results.slice(MAX_ROW_ENTRIES, MAX_ROW_ENTRIES + 10).every(r => r.status === 'rejected' && r.reason.message.includes('capacity exceeded'))).toBe(true)
  expect(results.at(-1)).toMatchObject({ status: 'rejected', reason: expect.any(Error) })
  expect(cache.size).toBe(0)
  for (let cycle = 0; cycle < 3; cycle++) {
    // More elapsed deadline windows and explicit clears must not admit another stalled batch.
    await new Promise(resolve => setTimeout(resolve, timeoutMs + 1))
    cache.clear()
    const retries = await Promise.allSettled(Array.from({ length: MAX_ROW_ENTRIES + 10 }, (_, i) => cache.resolve(host, `${cycle}-${i}`)))
    expect(retries.every(r => r.status === 'rejected' && r.reason.message.includes('capacity exceeded'))).toBe(true)
    expect(calls).toBe(MAX_ROW_ENTRIES)
    expect(active).toBe(MAX_ROW_ENTRIES)
    expect(cache.size).toBe(0)
  }
  finish({ sessions: [] })
  // Let the underlying loads and their settlement accounting finish, independently of callers.
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(active).toBe(0)
  host.sessions = async () => ({ sessions: [] }) as unknown as Awaited<ReturnType<NonNullable<StartHost['sessions']>>>
  expect(await cache.resolve(host, 'recovered')).toBeUndefined()
  expect(cache.size).toBe(1)
})

test('an oversized pending burst stays capped after settlement and cleans expired entries', async () => {
  let now = 0, calls = 0
  let finish!: (value: { sessions: ControlSession[] }) => void
  const fleet = new Promise<{ sessions: ControlSession[] }>(resolve => { finish = resolve })
  const host = { sessions: () => { calls++; return fleet } } as unknown as StartHost
  const cache = createSessionRowCache(() => now)
  const outcomes = Promise.allSettled(Array.from({ length: MAX_ROW_ENTRIES + 10 }, (_, i) => cache.resolve(host, String(i))))
  await Promise.resolve()
  expect(cache.size).toBe(MAX_ROW_ENTRIES)
  finish({ sessions: [] })
  const results = await outcomes
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(MAX_ROW_ENTRIES)
  expect(calls).toBe(MAX_ROW_ENTRIES)
  expect(cache.size).toBe(MAX_ROW_ENTRIES)
  await cache.resolve(host, 'next')
  expect(cache.size).toBe(MAX_ROW_ENTRIES)
  now = 2_000
  await cache.resolve(host, 'after-expiry')
  expect(cache.size).toBe(1)
})

test('settlement removes expired rows without waiting for another miss', async () => {
  let now = 0
  const cache = createSessionRowCache(() => now)
  const { host } = fixture()
  await cache.resolve(host, 'selected')
  let finish!: (value: { sessions: ControlSession[] }) => void
  host.sessions = (() => new Promise<{ sessions: ControlSession[] }>(resolve => { finish = resolve })) as NonNullable<StartHost['sessions']>
  const pending = cache.resolve(host, 'other')
  await Promise.resolve()
  expect(cache.size).toBe(2)
  now = 2_000
  finish({ sessions: [] })
  await pending
  expect(cache.size).toBe(1)
})

test('invalidation cannot bypass the pending admission cap', async () => {
  let finish!: (value: { sessions: ControlSession[] }) => void
  const fleet = new Promise<{ sessions: ControlSession[] }>(resolve => { finish = resolve })
  const host = { sessions: () => fleet } as unknown as StartHost
  const cache = createSessionRowCache()
  const reads = Promise.all(Array.from({ length: MAX_ROW_ENTRIES }, (_, i) => cache.resolve(host, String(i))))
  cache.clear()
  await expect(cache.resolve(host, 'after-invalidation')).rejects.toThrow('capacity exceeded')
  finish({ sessions: [] })
  await reads
  expect(cache.size).toBe(0)
  expect(await cache.resolve(host, 'after-settlement')).toBeUndefined()
})
