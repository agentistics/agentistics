import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { containsPending, continuesByUuids, followFork, forgetForks, tailUuids } from './transcript-fork'
import { readChatWindow } from './chat-tail'
import { resolveChatTranscriptPath } from './chat-tail'
import { transcriptReaderFor } from './harness-transcript'

const OLD_ID = '0b31a8f4-cdc6-410e-9f34-894e22cee24d'
const NEW_ID = 'e96caf0e-480b-4d9c-8a59-6cfb983c1510'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = (uuid: string, sid: string, text: string, ts: string) => JSON.stringify({ type: 'user', uuid, sessionId: sid, timestamp: ts, message: { role: 'user', content: text } })
const asst = (uuid: string, sid: string, text: string, ts: string) => JSON.stringify({ type: 'assistant', uuid, sessionId: sid, timestamp: ts, message: { role: 'assistant', id: `m${uuid}`, content: [{ type: 'text', text }] } })

// The old file: three turns, the last answer being the limit notice.
const oldLines = [
  user(id(1), OLD_ID, 'first question', '2026-10-05T10:00:00Z'),
  asst(id(2), OLD_ID, 'first answer', '2026-10-05T10:00:05Z'),
  user(id(3), OLD_ID, 'is everything ready?', '2026-10-05T10:30:00Z'),
  asst(id(4), OLD_ID, "You've hit your weekly limit", '2026-10-05T10:30:02Z'),
]
// After /login: a NEW file replays the history under the new session id, then continues it.
const newLines = [
  JSON.stringify({ type: 'ai-title', sessionId: NEW_ID }),
  ...oldLines.map(l => l.replace(OLD_ID, NEW_ID)),
  user(id(5), NEW_ID, 'is everything ready?', '2026-10-05T10:40:00Z'),
  asst(id(6), NEW_ID, 'No, not everything is ready yet', '2026-10-05T10:40:09Z'),
]

let root = ''
let dir = ''
beforeEach(() => {
  forgetForks()
  if (root) rmSync(root, { recursive: true, force: true })
  root = mkdtempSync(join(tmpdir(), 'fork-'))
  dir = join(root, 'projects', '-home-me-work')
  mkdirSync(dir, { recursive: true })
})
const write = (name: string, lines: string[], mtimeSec: number) => {
  const p = join(dir, name)
  writeFileSync(p, lines.join('\n') + '\n')
  utimesSync(p, mtimeSec, mtimeSec)
  return p
}

describe('pure decisions', () => {
  test('tailUuids keeps the last n, in order', () => {
    expect(tailUuids(oldLines.join('\n'), 2)).toEqual([id(3), id(4)])
  })
  test('a replaying file continues; an unrelated one does not', () => {
    const tail = tailUuids(oldLines.join('\n'))
    expect(continuesByUuids(tail, newLines.join('\n'))).toBe(true)
    expect(continuesByUuids(tail, user(id(90), 'x', 'other', 't'))).toBe(false)
    expect(continuesByUuids([], 'anything')).toBe(false)
  })
  test('a pending prompt only the candidate has is the proof for a fork that does not replay', () => {
    const cand = user(id(50), NEW_ID, 'please run the migration now', 't')
    expect(containsPending(['please run the migration now'], cand, oldLines.join('\n'))).toBe(true)
    expect(containsPending(['is everything ready?'], newLines.join('\n'), oldLines.join('\n'))).toBe(false) // already in the old one
    expect(containsPending(['short'], cand, '')).toBe(false)
  })
})

describe('followFork — two transcript files', () => {
  test('REPRODUCTION: the conversation moved to a newer file -> the successor is returned', async () => {
    const oldP = write(`${OLD_ID}.jsonl`, oldLines, 1000)
    const newP = write(`${NEW_ID}.jsonl`, newLines, 2000)
    expect(await followFork(oldP)).toBe(newP)
  })

  test('history stays readable and the answer shows: the followed file holds old AND new turns', async () => {
    const oldP = write(`${OLD_ID}.jsonl`, oldLines, 1000)
    write(`${NEW_ID}.jsonl`, newLines, 2000)
    const followed = await followFork(oldP)
    const { turns } = await readChatWindow(followed, 400)
    const texts = turns.map(t => t.text)
    expect(texts).toContain('first question') // old turns stay
    expect(texts).toContain('No, not everything is ready yet') // the real answer
    expect(texts.some(t => t.includes('weekly limit'))).toBe(true)
    // and the echo of "is everything ready?" now resolves against the file that holds it
    expect(turns.filter(t => t.role === 'user').map(t => t.text)).toContain('is everything ready?')
  })

  test('an unrelated newer sibling (another session) is NOT followed', async () => {
    const oldP = write(`${OLD_ID}.jsonl`, oldLines, 1000)
    write('11111111-1111-4111-8111-111111111111.jsonl', [user(id(70), 'other', 'unrelated work', 't')], 2000)
    expect(await followFork(oldP)).toBe(oldP)
  })

  test('an OLDER sibling is never a successor, even if it replays', async () => {
    const oldP = write(`${OLD_ID}.jsonl`, oldLines, 3000)
    write(`${NEW_ID}.jsonl`, newLines, 1000)
    expect(await followFork(oldP)).toBe(oldP)
  })

  test('a fork that does not replay is followed through the pending prompt', async () => {
    const oldP = write(`${OLD_ID}.jsonl`, oldLines, 1000)
    const fresh = write(`${NEW_ID}.jsonl`, [user(id(80), NEW_ID, 'deploy the hotfix please', 't')], 2000)
    expect(await followFork(oldP)).toBe(oldP)
    forgetForks()
    expect(await followFork(oldP, { pending: ['deploy the hotfix please'] })).toBe(fresh)
  })

  test('a chain of forks is followed to its end', async () => {
    const a = write(`${OLD_ID}.jsonl`, oldLines, 1000)
    write(`${NEW_ID}.jsonl`, newLines, 2000)
    const third = '22222222-2222-4222-8222-222222222222'
    const c = write(`${third}.jsonl`, [...newLines.map(l => l.replace(NEW_ID, third)), user(id(7), third, 'again', 't')], 3000)
    expect(await followFork(a)).toBe(c)
  })

  test('once found, the successor is remembered; a vanished one is dropped', async () => {
    const oldP = write(`${OLD_ID}.jsonl`, oldLines, 1000)
    const newP = write(`${NEW_ID}.jsonl`, newLines, 2000)
    expect(await followFork(oldP)).toBe(newP)
    rmSync(newP)
    expect(await followFork(oldP)).toBe(oldP)
  })
})

describe('fork refusal diagnostics', () => {
  test.each([undefined, '0'])('CLI readers stay silent with SERVE_STATIC=%s', async serveStatic => {
    const saved = process.env.SERVE_STATIC
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      if (serveStatic === undefined) delete process.env.SERVE_STATIC
      else process.env.SERVE_STATIC = serveStatic
      const oldP = write(`${OLD_ID}.jsonl`, oldLines, 1000)
      const newP = write(`${NEW_ID}.jsonl`, newLines, 2000)
      const foreign = new Set([NEW_ID])
      expect(await followFork(oldP, { foreign })).toBe(oldP)
      expect(warn).not.toHaveBeenCalled()

      // Silencing a CLI read must not consume the server's once-per-pair diagnostic.
      process.env.SERVE_STATIC = '1'
      expect(await followFork(oldP, { foreign })).toBe(oldP)
      expect(await followFork(oldP, { foreign })).toBe(oldP)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(`[sessions] refused to follow ${OLD_ID} into ${NEW_ID}: another session is linked to that conversation`)
      expect(await followFork(oldP)).toBe(newP)
    } finally {
      warn.mockRestore()
      if (saved === undefined) delete process.env.SERVE_STATIC
      else process.env.SERVE_STATIC = saved
    }
  })

  test('the server remembers refused pairs after more than 512 distinct collisions', async () => {
    const saved = process.env.SERVE_STATIC
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const fs = {
      readdir: async () => ['old.jsonl', 'foreign.jsonl'],
      stat: async (p: string) => ({ mtimeMs: p.endsWith('/old.jsonl') ? 1 : 2, size: 100 }),
      readFile: async () => oldLines.join('\n'),
    }
    try {
      process.env.SERVE_STATIC = '1'
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < 600; i++) {
          const from = `/project-${i}/old.jsonl`
          expect(await followFork(from, { fs, foreign: new Set(['foreign']) })).toBe(from)
        }
      }
      expect(warn).toHaveBeenCalledTimes(600)
    } finally {
      warn.mockRestore()
      if (saved === undefined) delete process.env.SERVE_STATIC
      else process.env.SERVE_STATIC = saved
    }
  })

  test('the server logs a remembered successor refusal only once per pair', async () => {
    const saved = process.env.SERVE_STATIC
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      process.env.SERVE_STATIC = '1'
      const oldP = write(`${OLD_ID}.jsonl`, oldLines, 1000)
      const newP = write(`${NEW_ID}.jsonl`, newLines, 2000)
      expect(await followFork(oldP)).toBe(newP)
      const foreign = new Set([NEW_ID])
      expect(await followFork(oldP, { foreign })).toBe(oldP)
      expect(await followFork(oldP, { foreign })).toBe(oldP)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
      if (saved === undefined) delete process.env.SERVE_STATIC
      else process.env.SERVE_STATIC = saved
    }
  })
})

describe('the claude reader follows through resolve()', () => {
  test('resolve({conversationId}) answers the NEW file after the fork, the old one before', async () => {
    // resolve() goes through PROJECTS_DIR, which is fixed at import; exercise the same chain by hand.
    const oldP = write(`${OLD_ID}.jsonl`, oldLines, 1000)
    expect(await resolveChatTranscriptPath('/home/me/work', OLD_ID, join(root, 'projects'))).toBe(oldP)
    const newP = write(`${NEW_ID}.jsonl`, newLines, 2000)
    expect(await followFork(oldP)).toBe(newP)
    expect(typeof transcriptReaderFor('claude')?.resolve).toBe('function')
  })
})

/**
 * CROSSBIND (2026-10-17, QA chat-activity-live-1): two sessions in ONE folder showed EACH OTHER's
 * conversation. Both were claude, each born linked to its own `--session-id`, so the registry was
 * right; the READ was not. `followFork` takes any NEWER sibling in the project directory that
 * replays the linked file's last uuids OR carries a prompt this session was sent — and a sibling
 * that is ANOTHER ROW'S OWN conversation satisfies both as soon as the two sessions share history
 * (both resumed or replayed the same conversation) or were sent the same prompt (a spawn queued by
 * the memory guard plus the same spawn started with `force`). The row then read the other row's
 * file, for good, through the successor memo.
 */
describe('followFork never walks into another row\'s conversation', () => {
  const A = '733fde78-b310-4e23-8794-69e4243890ff'
  const B = '606e75fb-d5e6-40ef-bb47-52f9f98364e8'
  // Two sessions replaying the same history: identical uuids, each under its own session id.
  const replay = (sid: string, n: number) => Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? user(id(100 + i), sid, `step ${i}`, 't') : asst(id(100 + i), sid, `did ${i}`, 't'))

  test('REPRODUCTION: a newer same-folder file sharing the uuids is the OTHER row\'s — not followed', async () => {
    const a = write(`${A}.jsonl`, replay(A, 30), 1000) // the session that stopped early
    const b = write(`${B}.jsonl`, replay(B, 46), 2000) // its sibling, still writing
    // Without knowing who owns B, the old rule took it (this is what the user saw).
    expect(await followFork(a)).toBe(b)
    forgetForks()
    expect(await followFork(a, { foreign: new Set([B]) })).toBe(a)
  })

  test('the queued + forced spawn: the same prompt in the sibling is not proof the file is ours', async () => {
    const prompt = 'review the chat activity branch please'
    const a = write(`${A}.jsonl`, [user(id(1), A, 'hello there', 't')], 1000)
    write(`${B}.jsonl`, [user(id(9), B, prompt, 't')], 2000)
    expect(await followFork(a, { pending: [prompt], foreign: new Set([B]) })).toBe(a)
  })

  test('a successor remembered BEFORE it was known to be another row\'s is dropped', async () => {
    const a = write(`${A}.jsonl`, replay(A, 30), 1000)
    const b = write(`${B}.jsonl`, replay(B, 46), 2000)
    expect(await followFork(a)).toBe(b)
    expect(await followFork(a, { foreign: new Set([B]) })).toBe(a)
  })

  test('a foreign file is skipped, and a real successor further down the list is still found', async () => {
    const a = write(`${OLD_ID}.jsonl`, oldLines, 1000)
    const mine = write(`${NEW_ID}.jsonl`, newLines, 2000)
    write(`${B}.jsonl`, newLines.map(l => l.replace(NEW_ID, B)), 3000)
    expect(await followFork(a, { foreign: new Set([B]) })).toBe(mine)
  })

  test('the owners may be asked lazily — once, and only when a newer sibling exists', async () => {
    let asked = 0
    const lazy = async () => { asked++; return new Set([B]) }
    const alone = write(`${A}.jsonl`, replay(A, 30), 1000)
    expect(await followFork(alone, { foreign: lazy })).toBe(alone)
    expect(asked).toBe(0) // nothing newer in the folder: the registry is never read
    write(`${B}.jsonl`, replay(B, 46), 2000)
    expect(await followFork(alone, { foreign: lazy })).toBe(alone)
    expect(asked).toBe(1)
  })

  test('the /login fork is still followed when nobody else owns the new file', async () => {
    const oldP = write(`${OLD_ID}.jsonl`, oldLines, 1000)
    const newP = write(`${NEW_ID}.jsonl`, newLines, 2000)
    expect(await followFork(oldP, { foreign: new Set([B]) })).toBe(newP)
  })
})
