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
