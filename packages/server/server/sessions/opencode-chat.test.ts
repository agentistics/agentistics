import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOpencodeChat } from './opencode-chat'
import { readOpencodeChat, resolveOpencodeChat, splitOpencodeChatPath } from './opencode-chat-io'
import { HARNESS_TRANSCRIPTS } from './harness-transcript'

const SES = 'ses_e70797397ffeSYPpraVLuN7l9J'
const msgs = [
  { id: 'msg_1', time_created: 1793409322088, data: JSON.stringify({ role: 'user' }) },
  { id: 'msg_2', time_created: 1793409323048, data: JSON.stringify({ role: 'assistant' }) },
  { id: 'msg_3', time_created: 1793409326195, data: JSON.stringify({ role: 'assistant' }) },
  { id: 'msg_4', time_created: 1793409327000, data: JSON.stringify({ role: 'assistant' }) },
]
const parts = [
  { id: 'prt_1', message_id: 'msg_1', data: JSON.stringify({ type: 'text', text: 'create b.txt with hello' }) },
  { id: 'prt_1b', message_id: 'msg_1', data: JSON.stringify({ type: 'text', text: 'injected file', synthetic: true }) },
  { id: 'prt_2', message_id: 'msg_2', data: JSON.stringify({ type: 'step-start' }) },
  { id: 'prt_3', message_id: 'msg_2', data: JSON.stringify({ type: 'reasoning', text: 'I will write it' }) },
  { id: 'prt_4', message_id: 'msg_2', data: JSON.stringify({ type: 'tool', tool: 'write', state: { status: 'completed', input: { filePath: '/p/b.txt', content: 'hello' } } }) },
  { id: 'prt_5', message_id: 'msg_3', data: JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'cd /p && ls -la' } } }) },
  { id: 'prt_6', message_id: 'msg_3', data: JSON.stringify({ type: 'text', text: 'Done — b.txt contains "hello".' }) },
  { id: 'prt_7', message_id: 'msg_4', data: '{not json' },
]

describe('parseOpencodeChat', () => {
  const turns = parseOpencodeChat(msgs, parts)
  test('one turn per message with something said; synthetic parts and empty steps dropped', () => {
    expect(turns.map(t => [t.role, t.text])).toEqual([
      ['user', 'create b.txt with hello'],
      ['assistant', ''],
      ['assistant', 'Done — b.txt contains "hello".'],
    ])
    expect(turns[0]!.at).toBe(new Date(1793409322088).toISOString())
  })
  test('tools keep opencode\'s names, carry the shared one, the file written and a shell summary', () => {
    expect(turns[1]!.thinking).toBe('I will write it')
    expect(turns[1]!.tools).toEqual([{ name: 'write', canonical: 'Write', detail: '/p/b.txt', writes: ['/p/b.txt'], ref: 'prt_4' }])
    const bash = turns[2]!.tools![0]!
    expect(bash.name).toBe('bash')
    expect(bash.failed).toBe(true)
    expect(bash.detail).toBe('ls -la')
  })
})

describe('opencode chat IO (read-only SQLite)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-chat-'))
  const db = join(dir, 'opencode.db')
  const w = new Database(db)
  w.exec('PRAGMA journal_mode=WAL')
  w.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER)')
  w.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  w.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  w.query('INSERT INTO session VALUES (?, ?, ?)').run(SES, '/p', 1)
  for (const m of msgs) w.query('INSERT INTO message VALUES (?, ?, ?, ?)').run(m.id, SES, m.time_created, m.data)
  parts.forEach((p, i) => w.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(p.id, p.message_id, SES, i, p.data))
  afterAll(() => { w.close(); rmSync(dir, { recursive: true, force: true }) })

  test('resolve names a session the store holds, and nothing else', async () => {
    expect(await resolveOpencodeChat(db, SES)).toBe(`${db}#${SES}`)
    expect(await resolveOpencodeChat(db, 'ses_e70797397ffeNOTthereNOTthr')).toBeNull()
    expect(await resolveOpencodeChat(db, '../etc/passwd')).toBeNull()
    expect(await resolveOpencodeChat(join(dir, 'missing.db'), SES)).toBeNull()
  })
  test('read sees committed WAL writes while the writer holds the store open', async () => {
    expect((await readOpencodeChat(`${db}#${SES}`))!.length).toBe(3)
    w.query('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_5', SES, 1793409330000, JSON.stringify({ role: 'user' }))
    w.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('prt_9', 'msg_5', SES, 99, JSON.stringify({ type: 'text', text: 'again' }))
    const turns = (await readOpencodeChat(`${db}#${SES}`))!
    expect(turns.at(-1)!.text).toBe('again')
  })
  test('the path is split strictly', () => {
    expect(splitOpencodeChatPath(`/a/b.db#${SES}`)).toEqual({ dbPath: '/a/b.db', sessionId: SES })
    expect(splitOpencodeChatPath('/a/b.db')).toBeNull()
    expect(splitOpencodeChatPath('/a/b.db#ses_x/../y')).toBeNull()
  })
  test('the opencode transcript entry reads through the same path', async () => {
    // Own fixture: the sibling test above writes 'again' into the shared db, so this
    // test must not depend on whether it ran first.
    const ownDir = mkdtempSync(join(tmpdir(), 'oc-chat-entry-'))
    const ownDb = join(ownDir, 'opencode.db')
    const ow = new Database(ownDb)
    try {
      ow.exec('PRAGMA journal_mode=WAL')
      ow.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER)')
      ow.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
      ow.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
      ow.query('INSERT INTO session VALUES (?, ?, ?)').run(SES, '/p', 1)
      for (const m of msgs) ow.query('INSERT INTO message VALUES (?, ?, ?, ?)').run(m.id, SES, m.time_created, m.data)
      parts.forEach((p, i) => ow.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(p.id, p.message_id, SES, i, p.data))
      const reader = HARNESS_TRANSCRIPTS.opencode!
      const read = await reader.read(`${ownDb}#${SES}`, 2)
      expect(read.older).toBe(true)
      expect(read.turns.length).toBe(2)
      expect((await reader.readRecent(`${ownDb}#${SES}`, 1)).map(t => t.text)).toEqual(['Done — b.txt contains "hello".'])
    } finally {
      ow.close()
      rmSync(ownDir, { recursive: true, force: true })
    }
  })
})

// MAC.OPENCODE-MUDO — a session created AFTER the 1.x → 2.x migration has no row in the frozen 1.x tables; every
// host reader (the hand-off briefing, the chat fallback) answered "o arquivo da conversa não foi encontrado".
describe('opencode 2.x sessions (session_v2 + the service API)', () => {
  const V2 = 'ses_e53f48c24ffeMy9oUiacfDl4ld'
  // Shape measured on 2.2.5 (engine fixture `v2.2.5/messages-…json`), text shortened.
  const v2Messages = [
    { id: 'msg_u1', type: 'user', time: { created: 1793887794793 }, text: 'WRITE_PROBE please', files: [] },
    { id: 'msg_a1', type: 'assistant', time: { created: 1793887794814, completed: 1793887794854 }, content: [
      { type: 'tool', id: 'call_1', name: 'write', state: { status: 'completed', input: { path: '/w/probe-out.txt', content: 'hello' } } },
      { type: 'tool', id: 'call_2', name: 'shell', state: { status: 'error', input: { command: 'cd /w && ls -la' } } },
    ] },
    { id: 'msg_a2', type: 'assistant', time: { created: 1793887794867 }, content: [{ type: 'reasoning', text: 'checking' }, { type: 'text', text: 'DONE' }] },
    { id: 'msg_i', type: 'idle', time: { created: 1793887794894 }, outcome: 'succeeded' },
    { id: 'msg_s', type: 'system', time: { created: 1793887899724 }, text: 'The environment you are running in is now: …' },
  ]
  const dir = mkdtempSync(join(tmpdir(), 'oc-chat-v2-'))
  const db = join(dir, 'opencode.db')
  const w = new Database(db)
  w.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER)')
  w.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  w.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  w.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT)')
  w.query('INSERT INTO session_v2 VALUES (?, ?)').run(V2, '/w')
  const noV2Table = join(dir, 'pre.db')
  const w2 = new Database(noV2Table)
  w2.exec('CREATE TABLE session (id TEXT PRIMARY KEY)')
  afterAll(() => { w.close(); w2.close(); rmSync(dir, { recursive: true, force: true }) })
  let calls = 0
  const source = () => ({ async messages(id: string) { calls++; if (id !== V2) throw new Error('HTTP 404'); return v2Messages } })

  test('resolve finds a 2.x session in session_v2, and refuses one absent there without asking the service', async () => {
    calls = 0
    expect(await resolveOpencodeChat(db, V2, source)).toBe(`${db}#${V2}`)
    expect(await resolveOpencodeChat(db, 'ses_e70797397ffeNOTthereNOTthr', source)).toBeNull()
    expect(calls).toBe(0)
  })
  test('with no session_v2 table to read, the service decides', async () => {
    expect(await resolveOpencodeChat(noV2Table, V2, source)).toBe(`${noV2Table}#${V2}`)
    expect(await resolveOpencodeChat(noV2Table, 'ses_e70797397ffeNOTthereNOTthr', source)).toBeNull()
    expect(await resolveOpencodeChat(noV2Table, V2, () => null)).toBeNull()
  })
  test('read turns 2.x messages into the same turns the 1.x reader produces; plumbing is dropped', async () => {
    const turns = (await readOpencodeChat(`${db}#${V2}`, source))!
    expect(turns.map(t => [t.role, t.text])).toEqual([['user', 'WRITE_PROBE please'], ['assistant', ''], ['assistant', 'DONE']])
    expect(turns[1]!.tools).toEqual([
      { name: 'write', canonical: 'Write', detail: '/w/probe-out.txt', writes: ['/w/probe-out.txt'], ref: 'msg_a1:0' },
      expect.objectContaining({ name: 'bash', failed: true, detail: 'ls -la', ref: 'msg_a1:1' }),
    ])
    expect(turns[2]!.thinking).toBe('checking')
    expect(turns[0]!.at).toBe(new Date(1793887794793).toISOString())
  })
  test('a fresh 2.x store has NO 1.x tables at all (measured on 2.2.5) and still resolves — the reopen path too', async () => {
    const fresh = join(dir, 'fresh.db')
    const f = new Database(fresh)
    f.exec('CREATE TABLE session_v2 (`id` text PRIMARY KEY, `project_id` text NOT NULL, `directory` text NOT NULL)')
    f.query('INSERT INTO session_v2 VALUES (?, ?, ?)').run(V2, 'p', '/w')
    f.close()
    expect(await resolveOpencodeChat(fresh, V2, () => null)).toBe(`${fresh}#${V2}`)
    const { exactLinksOnDisk, resetReopenLinkMemo } = await import('./reopen-link')
    resetReopenLinkMemo()
    const onDisk = await exactLinksOnDisk([{ harness: 'opencode', cwd: '/w', conversationId: V2 }], [], Date.now(), (_h, ref) => resolveOpencodeChat(fresh, ref.conversationId, () => null))
    expect([...onDisk]).toEqual([V2])
    expect((await readOpencodeChat(`${fresh}#${V2}`, source))!.at(-1)!.text).toBe('DONE')
  })
  test('an unreachable service is null (unread), never a confident empty chat', async () => {
    expect(await readOpencodeChat(`${db}#${V2}`, () => ({ async messages() { throw new Error('ECONNREFUSED') } }))).toBeNull()
  })
})
