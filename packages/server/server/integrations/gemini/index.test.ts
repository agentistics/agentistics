import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGeminiReplay } from './index'

/** A throwaway `~/.gemini`-shaped directory, cleaned up after each test. */
async function makeGeminiDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentistics-gemini-replay-'))
}

async function writeChat(geminiDir: string, project: string, fileName: string, content: string): Promise<void> {
  const dir = join(geminiDir, 'tmp', project, 'chats')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, fileName), content, 'utf-8')
}

const RICH_JSON = JSON.stringify({
  sessionId: 'io-test-session',
  startTime: '2026-05-01T00:00:00.000Z',
  lastUpdated: '2026-05-01T00:01:00.000Z',
  messages: [
    { id: 'u1', timestamp: '2026-05-01T00:00:00.000Z', type: 'user', content: [{ text: 'x' }] },
    {
      id: 'g1', timestamp: '2026-05-01T00:00:30.000Z', type: 'gemini', content: 'y',
      model: 'gemini-3-flash-preview', tokens: { input: 10, output: 5, cached: 0 },
    },
  ],
})

describe('createGeminiReplay — discover()', () => {
  test('finds a chat file under <geminiDir>/tmp/<project>/chats/, skipping the bin directory', async () => {
    const geminiDir = await makeGeminiDir()
    try {
      await writeChat(geminiDir, 'myproj', 'session-io-test.json', RICH_JSON)
      await mkdir(join(geminiDir, 'tmp', 'bin', 'chats'), { recursive: true })
      await writeFile(join(geminiDir, 'tmp', 'bin', 'chats', 'ignored.json'), '{}', 'utf-8')

      const replay = createGeminiReplay({ geminiDir })
      const sources = await replay.discover()

      expect(sources).toHaveLength(1)
      expect(sources[0]).toEqual({
        sessionId: 'myproj/session-io-test', sourceRef: 'gemini:myproj/session-io-test',
      })
    } finally {
      await rm(geminiDir, { recursive: true, force: true })
    }
  })

  test('resolves the project path from projects.json', async () => {
    const geminiDir = await makeGeminiDir()
    try {
      await writeChat(geminiDir, 'shortname', 'session-a.json', RICH_JSON)
      await writeFile(join(geminiDir, 'projects.json'), JSON.stringify({
        projects: { '/home/user/real-project': 'shortname' },
      }), 'utf-8')

      const replay = createGeminiReplay({ geminiDir })
      await replay.discover()
      const batch = await replay.replay({ sessionId: 'shortname/session-a', sourceRef: 'gemini:shortname/session-a' }, null)

      const runStarted = batch.events.find(e => e.type === 'run.started')!
      expect((runStarted.data as { cwd?: string }).cwd).toBe('/home/user/real-project')
    } finally {
      await rm(geminiDir, { recursive: true, force: true })
    }
  })
})

describe('createGeminiReplay — replay()', () => {
  test('reads a discovered file and emits its events', async () => {
    const geminiDir = await makeGeminiDir()
    try {
      await writeChat(geminiDir, 'proj', 'session-b.json', RICH_JSON)
      const replay = createGeminiReplay({ geminiDir })
      await replay.discover()
      const batch = await replay.replay({ sessionId: 'proj/session-b', sourceRef: 'gemini:proj/session-b' }, null)

      expect(batch.events.length).toBeGreaterThan(0)
      expect(batch.events[0]!.type).toBe('session.started')
      expect(batch.cursor).toBeNull()
    } finally {
      await rm(geminiDir, { recursive: true, force: true })
    }
  })

  test('replaying an id NEVER discovered still resolves it (the id names its own path)', async () => {
    const geminiDir = await makeGeminiDir()
    try {
      await writeChat(geminiDir, 'proj', 'session-c.json', RICH_JSON)
      const replay = createGeminiReplay({ geminiDir })
      // no discover() call at all
      const batch = await replay.replay({ sessionId: 'proj/session-c', sourceRef: 'gemini:proj/session-c' }, null)
      expect(batch.events.length).toBeGreaterThan(0)
    } finally {
      await rm(geminiDir, { recursive: true, force: true })
    }
  })

  test('an unknown id resolves to no events, never an error', async () => {
    const geminiDir = await makeGeminiDir()
    try {
      const replay = createGeminiReplay({ geminiDir })
      const batch = await replay.replay({ sessionId: 'nope/nothing-here', sourceRef: 'gemini:nope/nothing-here' }, null)
      expect(batch.events).toEqual([])
    } finally {
      await rm(geminiDir, { recursive: true, force: true })
    }
  })

  test('replaying the same file twice yields identical event ids (idempotent, no cursor needed)', async () => {
    const geminiDir = await makeGeminiDir()
    try {
      await writeChat(geminiDir, 'proj', 'session-d.json', RICH_JSON)
      const replay = createGeminiReplay({ geminiDir })
      await replay.discover()
      const first = await replay.replay({ sessionId: 'proj/session-d', sourceRef: 'gemini:proj/session-d' }, null)
      const second = await replay.replay({ sessionId: 'proj/session-d', sourceRef: 'gemini:proj/session-d' }, first.cursor)
      expect(second.events.map(e => e.eventId)).toEqual(first.events.map(e => e.eventId))
    } finally {
      await rm(geminiDir, { recursive: true, force: true })
    }
  })
})
