import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationResumeLock } from './conversation-resume-lock'

test('independent processes cannot enter one conversation claim together', async () => {
  const root = mkdtempSync(join(tmpdir(), 'conv-lock-'))
  const events = join(root, 'events')
  const module = new URL('./conversation-resume-lock.ts', import.meta.url).href
  const source = `
    import { createConversationResumeLock } from ${JSON.stringify(module)};
    import { appendFileSync } from 'node:fs';
    const lock = createConversationResumeLock(process.argv[1]);
    await lock('conversation', async () => {
      appendFileSync(process.argv[2], 'start\\n');
      await new Promise(r => setTimeout(r, 50));
      appendFileSync(process.argv[2], 'end\\n');
    });
  `
  try {
    const workers = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, '-e', source, root, events], { stdout: 'pipe', stderr: 'pipe' }))
    expect(await Promise.all(workers.map(p => p.exited))).toEqual([0, 0, 0])
    expect(readFileSync(events, 'utf8')).toBe('start\nend\nstart\nend\nstart\nend\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 10_000)

test('a busy claim times out without ever running the competing spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'conv-lock-timeout-'))
  const first = createConversationResumeLock(root)
  const second = createConversationResumeLock(root, 10)
  let calls = 0
  try {
    await first('conversation', async () => {
      await expect(second('conversation', async () => { calls++ })).rejects.toThrow('already in progress')
    })
    expect(calls).toBe(0)
    // A released or failed attempt does not wedge the conversation.
    await second('conversation', async () => { calls++ })
    expect(calls).toBe(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a process exiting inside the claim leaves a recoverable dead owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'conv-lock-dead-'))
  const module = new URL('./conversation-resume-lock.ts', import.meta.url).href
  const source = `
    import { createConversationResumeLock } from ${JSON.stringify(module)};
    await createConversationResumeLock(process.argv[1])('conversation', async () => process.exit(0));
  `
  try {
    const child = Bun.spawn([process.execPath, '-e', source, root], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(0)
    expect(await createConversationResumeLock(root)('conversation', async () => 'recovered')).toBe('recovered')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
