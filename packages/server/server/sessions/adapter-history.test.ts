/**
 * adapter-history.test.ts — V-READ: the chat snapshot, older pages and search served from the engine's
 * optional 1.22 contract (`status`/`history`/`search`), and ONLY for a harness that declares it.
 */
import { describe, expect, test } from 'bun:test'
import type {
  ChatHistoryPage, ChatSearchPage, ChatSourceRef, ChatUnavailable, EngineChatTurn, HarnessChat,
} from '@agentistics/engine-api'
import type { ChatTurn } from '@agentistics/core'
import {
  historyOf, historySentence, hostHitOf, readAdapterHistory, searchAdapterHistory, type AdapterChatRow,
} from './adapter-chat'
import { searchSessionChat, type EngineSearch } from './chat-search-web'

const t = (text: string, role: 'user' | 'assistant' = 'user'): EngineChatTurn => ({ role, text })
const row = (extra: Partial<AdapterChatRow> = {}): AdapterChatRow =>
  ({ id: 'r1', harness: 'claude', cwd: '/w', state: 'idle', conversationId: 'c1', ...extra })
const src: ChatSourceRef = { harness: 'claude', conversationId: 'c1', sourceRef: '/x/c1.jsonl' }

type HistFn = (q: { before?: string; snapshot?: string; limit?: number }) => ChatHistoryPage | ChatUnavailable
type SearchFn = (q: { query: string; cursor?: string }) => ChatSearchPage | ChatUnavailable

/** A chat that declares history; `follow`/`resolve` are counted — the LEGACY readers of the channel. */
function histChat(history: HistFn, search: SearchFn = () => ({ status: 'absent', reason: 'x' })) {
  const calls = { history: 0, search: 0, resolve: 0, follow: 0 }
  const chat: HarnessChat = {
    declares: {
      state: { from: 'x' }, attention: { absent: 'n' }, live: { absent: 'n' }, fork: { absent: 'n' }, history: { from: 'jsonl' },
    },
    async resolve() { calls.resolve++; return src },
    follow() { calls.follow++; return () => {} },
    async status() { return { kind: 'ready' } },
    async history(_r, q) { calls.history++; return history(q ?? {}) },
    async search(_r, q) { calls.search++; return search(q) },
  }
  return { chat, calls }
}

const page = (turns: EngineChatTurn[], o: Partial<ChatHistoryPage> = {}): ChatHistoryPage =>
  ({ status: 'ready', turns, start: 0, before: null, snapshot: 'snap1', total: turns.length, sourceEpoch: 'dev1.0', ...o })

const finish = async (read: { turns: ChatTurn[]; older: boolean }, live: boolean) =>
  ({ turns: read.turns, live, ...(read.older ? { older: 'older' } : {}) })

const base = (chat: HarnessChat, extra: Record<string, unknown> = {}) => ({
  conversationId: 'c1', chat, row: row(), pending: [], max: 400, lang: 'en' as const, finish, ...extra,
})

describe('historyOf — only a harness that DECLARES history takes the new path', () => {
  test('declared + members → used; declared absence, 1.21 entry, half-implemented → null', () => {
    const { chat } = histChat(() => page([]))
    expect(historyOf(chat)).toBe(chat as never)
    const absent: HarnessChat = { ...chat, declares: { ...chat.declares, history: { absent: 'reads files itself' } } }
    expect(historyOf(absent)).toBeNull()
    const old: HarnessChat = { declares: { state: { from: 'x' }, attention: { absent: 'n' }, live: { absent: 'n' }, fork: { absent: 'n' } }, resolve: chat.resolve, follow: chat.follow }
    expect(historyOf(old)).toBeNull()
    const half: HarnessChat = { ...old, declares: chat.declares, history: chat.history }
    expect(historyOf(half)).toBeNull()
  })
})

describe('M01 — the snapshot comes from history(), with status and cursor', () => {
  for (const harness of ['claude', 'opencode']) {
    test(`${harness}: first page + cursor + snapshot, window notice only on the newest page`, async () => {
      const { chat, calls } = histChat(() => page([t('a'), t('b')], { start: 40, total: 42, before: 'CUR1' }))
      const out = await readAdapterHistory(base(chat, { row: row({ harness }) }))
      if (!('payload' in out)) throw new Error('expected a payload')
      expect(out.payload.turns.map(x => x.text)).toEqual(['a', 'b'])
      expect(out.payload.history).toEqual({ status: 'ready', start: 40, total: 42, before: 'CUR1', snapshot: 'snap1', epoch: 'dev1.0' })
      expect(out.payload.source).toBe('adapter')
      expect(out.payload.older).toBe('older')
      expect(calls.history).toBe(1)
    })
  }

  test('an older page sends the cursor back and carries no "last N turns" notice', async () => {
    let asked: Parameters<HistFn>[0] | null = null
    const { chat } = histChat(q => { asked = q; return page([t('old')], { before: null }) })
    const out = await readAdapterHistory(base(chat, { before: 'CUR1', snapshot: 'snap1' }))
    expect(asked).toMatchObject({ before: 'CUR1', snapshot: 'snap1', limit: 400 })
    if (!('payload' in out)) throw new Error('payload')
    expect(out.payload.older).toBeUndefined()
    expect(out.payload.history?.before).toBeNull()
  })
})

describe('M11 — ready([]) is a valid empty conversation: no other reader is asked', () => {
  test('0 resolve/follow calls, a payload with no `unavailable`', async () => {
    const { chat, calls } = histChat(() => page([]))
    const out = await readAdapterHistory(base(chat))
    if (!('payload' in out)) throw new Error('payload')
    expect(out.payload.turns).toEqual([])
    expect(out.payload.unavailable).toBeUndefined()
    expect(out.payload.history).toMatchObject({ status: 'ready', total: 0 })
    expect(calls.resolve).toBe(0)
    expect(calls.follow).toBe(0)
  })
})

describe('pending / error are never rendered as an empty conversation', () => {
  test('pending → a "not ready yet" sentence + retryAfterMs', async () => {
    const { chat } = histChat(() => ({ status: 'pending', reason: 'no file', retryAfterMs: 1500 }))
    const out = await readAdapterHistory(base(chat, { lang: 'pt' }))
    if (!('payload' in out)) throw new Error('payload')
    expect(out.payload.unavailable).toContain('ainda não está pronta')
    expect(out.payload.transcript?.state).toBe('not-yet-written')
    expect(out.payload.history).toEqual({ status: 'pending', retryAfterMs: 1500 })
  })
  test('error → a sentence with the code, never []-as-success', async () => {
    const { chat } = histChat(() => ({ status: 'error', code: 'unreadable', reason: '/secret/path denied', retryable: true }))
    const out = await readAdapterHistory(base(chat))
    if (!('payload' in out)) throw new Error('payload')
    expect(out.payload.unavailable).toContain('could not be read')
    expect(out.payload.unavailable).not.toContain('/secret/path')
    expect(out.payload.transcript?.state).toBe('unreadable')
    expect(out.payload.history).toMatchObject({ status: 'error', code: 'unreadable', retryable: true })
  })
  test('a history() that THROWS (breaks the contract) is handed back to the caller as failed, not as empty', async () => {
    const { chat } = histChat(() => { throw new Error('boom') })
    expect(await readAdapterHistory(base(chat))).toEqual({ legacy: 'failed' })
  })
  test('absent → the legacy flow, untouched', async () => {
    const { chat } = histChat(() => ({ status: 'absent', reason: 'no source' }))
    expect(await readAdapterHistory(base(chat))).toEqual({ legacy: 'absent' })
  })
  test('an undeclared harness is absent without any call', async () => {
    const { chat, calls } = histChat(() => page([t('x')]))
    const undeclared: HarnessChat = { ...chat, declares: { ...chat.declares, history: { absent: 'own readers' } } }
    expect(await readAdapterHistory(base(undeclared))).toEqual({ legacy: 'absent' })
    expect(calls.history).toBe(0)
  })
})

describe('epoch change → the client is told to resnapshot', () => {
  for (const code of ['epoch-changed', 'bad-cursor', 'foreign'] as const) {
    test(code, async () => {
      const { chat } = histChat(() => ({ status: 'error', code, reason: 'r', retryable: true }))
      const out = await readAdapterHistory(base(chat, { before: 'OLD', snapshot: 'snap0' }))
      if (!('payload' in out)) throw new Error('payload')
      expect(out.payload.turns).toEqual([])
      expect(out.payload.history).toMatchObject({ status: 'error', code, resnapshot: true })
      expect(out.payload.unavailable).toContain('reloading')
    })
  }
  test('an error on the FIRST page is not a resnapshot request (nothing to drop)', async () => {
    const { chat } = histChat(() => ({ status: 'error', code: 'epoch-changed', reason: 'r', retryable: true }))
    const out = await readAdapterHistory(base(chat))
    if (!('payload' in out)) throw new Error('payload')
    expect(out.payload.history?.resnapshot).toBeUndefined()
  })
})

describe('CROSSBIND — a source that is another row\'s is not served', () => {
  test('foreign → handed back as failed; history() is not even asked', async () => {
    const { chat, calls } = histChat(() => page([t('x')]))
    const foreign = async () => new Set(['c1'])
    const other = { ...chat, async resolve() { return { ...src, conversationId: 'c-other', sourceRef: '/x/c-other.jsonl' } } } as HarnessChat
    const out = await readAdapterHistory(base(other, { foreign: async () => new Set(['c-other']) }))
    expect(out).toEqual({ legacy: 'failed' })
    expect(calls.history).toBe(0)
    void foreign
  })
})

describe('M09 — search through the engine, honest about completeness', () => {
  const hit = { index: 3, role: 'user' as const, snippet: 'a Migração roda no boot', before: 'B3' }
  const ready = (o: Partial<ChatSearchPage>): ChatSearchPage =>
    ({ status: 'ready', hits: [hit], complete: true, cursor: null, scanned: 10, snapshot: 's', sourceEpoch: 'e', ...o })

  test('hits are mapped to the host shape (excerpt + highlights), complete passes through', async () => {
    const { chat } = histChat(() => page([]), () => ready({}))
    const out = await searchAdapterHistory({ conversationId: 'c1', chat, query: 'migracao', lang: 'en' })
    expect(out).toMatchObject({ complete: true, cursor: null, scanned: 10, total: 1 })
    const h = out!.hits[0]!
    expect(h.excerpt.slice(h.highlights[0]!.start, h.highlights[0]!.end)).toBe('Migração')
    expect(hostHitOf(hit, 'migracao').index).toBe(3)
  })
  test('INCOMPLETE is flagged — with zero hits it is never a bare "none"', async () => {
    const { chat } = histChat(() => page([]), () => ready({ hits: [], complete: false, stopped: 'budget', cursor: 'NEXT' }))
    const out = await searchAdapterHistory({ conversationId: 'c1', chat, query: 'migracao', lang: 'en' })
    expect(out).toMatchObject({ hits: [], complete: false, stopped: 'budget', cursor: 'NEXT' })
  })
  test('the cursor is passed back to continue; pending/error are a sentence with complete:false', async () => {
    let seen: string | undefined
    const { chat } = histChat(() => page([]), q => { seen = q.cursor; return { status: 'error', code: 'timeout', reason: 'r', retryable: true } })
    const out = await searchAdapterHistory({ conversationId: 'c1', chat, query: 'migracao', cursor: 'NEXT', lang: 'en' })
    expect(seen).toBe('NEXT')
    expect(out).toMatchObject({ complete: false, hits: [] })
    expect(out!.unavailable).toContain('too long')
  })
  test('absent or undeclared → null (the host search serves); a granted secret is scrubbed from snippets', async () => {
    const a = histChat(() => page([]), () => ({ status: 'absent', reason: 'x' }))
    expect(await searchAdapterHistory({ conversationId: 'c1', chat: a.chat, query: 'zz', lang: 'en' })).toBeNull()
    const u: HarnessChat = { ...a.chat, declares: { ...a.chat.declares, history: { absent: 'own' } } }
    expect(await searchAdapterHistory({ conversationId: 'c1', chat: u, query: 'zz', lang: 'en' })).toBeNull()
    const { chat } = histChat(() => page([]), () => ready({}))
    const out = await searchAdapterHistory({
      conversationId: 'c1', chat, query: 'migracao', lang: 'en',
      scrub: async v => JSON.parse(JSON.stringify(v).replace('Migração', '«vault:K»')),
    })
    expect(out!.hits[0]!.text).toContain('«vault:K»')
  })
})

describe('searchSessionChat — flag OFF is the legacy search; engine answers only when it can', () => {
  const host = { sessions: async () => ({ sessions: [{ id: 's', harness: 'claude', cwd: '/x', conversationId: 'c1', state: 'exited' }] }) } as never
  const reader = (turns: ChatTurn[]) => () => ({ resolve: async () => '/p', read: async () => ({ turns, older: false }), readRecent: async () => [] }) as never

  test('no engine search (flag off) → the transcript reader serves, no `complete` field', async () => {
    const out = await searchSessionChat(host, 'en', 's', 'agulha', {}, reader([{ role: 'user', text: 'uma agulha' }]), null)
    expect(out.total).toBe(1)
    expect(out.complete).toBeUndefined()
  })
  test('engine search answering → used, the legacy reader is NOT read', async () => {
    let read = false
    const legacy = () => ({ resolve: async () => { read = true; return null }, read: async () => ({ turns: [], older: false }), readRecent: async () => [] }) as never
    const viaEngine: EngineSearch = async () => ({ query: 'agulha', total: 0, offset: 0, hits: [], scanned: 5, complete: false, stopped: 'budget', cursor: 'N' })
    const out = await searchSessionChat(host, 'en', 's', 'agulha', {}, legacy, viaEngine)
    expect(out).toMatchObject({ complete: false, stopped: 'budget', cursor: 'N' })
    expect(read).toBe(false)
  })
  test('engine search null (undeclared / absent) → falls back to the legacy reader', async () => {
    const out = await searchSessionChat(host, 'en', 's', 'agulha', {}, reader([{ role: 'user', text: 'uma agulha' }]), async () => null)
    expect(out.total).toBe(1)
  })
  test('a too-short query is refused before the engine is asked', async () => {
    let asked = false
    const out = await searchSessionChat(host, 'en', 's', 'a', {}, reader([]), async () => { asked = true; return null })
    expect(out.tooShort).toBe(true)
    expect(asked).toBe(false)
  })
})

test('historySentence is localized and never empty', () => {
  for (const lang of ['en', 'pt'] as const) {
    for (const u of [
      { status: 'pending', reason: '', retryAfterMs: 1 }, { status: 'absent', reason: '' },
      { status: 'error', code: 'unreadable', reason: '', retryable: false },
    ] as ChatUnavailable[]) expect(historySentence(u, lang).length).toBeGreaterThan(10)
  }
})
