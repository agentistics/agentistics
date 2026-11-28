/**
 * SESSAO.AVISO-NA-THREAD r3 — the mark "this turn follows a notice" through the REAL record path: `sendSessionMessage` →
 * the real `defaultMessageDeps().prompt` → `runFleetAction('prompt')` → its `record()`. Only the pane (the fleet host),
 * the fleet rows and the board are faked; nothing about the store or the record step is. That record is NEWER than
 * `sendSessionMessage`'s own note, so without the kind on it the mark is erased and the receiver reads "needs you".
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setFleetHostForTest, runFleetAction } from './fleet-web'
import { lastMessageTo } from './last-message'
import { restartLastMessages, useLastMessagesFile } from './last-message-file.testing'
import { defaultMessageDeps, resetMessageRateLimit, sendSessionMessage, type MessageDeps } from './session-message'

const SENDER = 'sender-1'
const TARGET = 'target-1'

let dir = ''
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'notice-record-')); useLastMessagesFile(join(dir, 'last-messages.json')) })
afterEach(() => { __setFleetHostForTest('en', null); resetMessageRateLimit() })
afterAll(() => { useLastMessagesFile(null); rmSync(dir, { recursive: true, force: true }) })

/** A pane that takes the keys after `delayMs`. */
function pane(delayMs = 0): void {
  __setFleetHostForTest('en', {
    // The record is stamped when the keys START, so the wait makes it strictly later than the message's own clock.
    async promptSession() { await Bun.sleep(delayMs); return { ok: true, message: 'sent' } },
  } as never)
}

async function deps(): Promise<MessageDeps> {
  return {
    ...(await defaultMessageDeps()),
    rows: async () => [{ id: TARGET, title: 'Leader', harness: 'claude', status: 'running' }] as never,
    resolveTarget: async r => r,
    senderTask: async () => ({}),
    comment: async () => ({ ok: true }),
    // Taken before the record's own stamp, as in the real flow.
    now: () => Date.now() - 5,
  }
}

const send = async (kind: string) => sendSessionMessage(SENDER, { to: TARGET, kind, body: 'handover: new id' }, await deps())

describe('the notice mark through the real record path', () => {
  test('survives the delivery record, on disk too', async () => {
    pane()
    expect(await send('notice')).toMatchObject({ ok: true, delivered: true })
    expect(lastMessageTo(TARGET)).toMatchObject({ from: SENDER, kind: 'notice' })
    await restartLastMessages()
    expect(lastMessageTo(TARGET)).toMatchObject({ from: SENDER, kind: 'notice' })
  })

  test('survives a record that lands after the acknowledgement deadline', async () => {
    pane(4_300)
    expect(await send('notice')).toMatchObject({ ok: true })
    await Bun.sleep(900)
    await restartLastMessages()
    expect(lastMessageTo(TARGET)).toMatchObject({ from: SENDER, kind: 'notice' })
  }, 20_000)

  test("a person's own message afterwards lifts it", async () => {
    pane()
    await send('notice')
    await Bun.sleep(5)
    expect(await runFleetAction('en', { action: 'prompt', id: TARGET, text: 'what happened?' })).toMatchObject({ ok: true })
    expect(lastMessageTo(TARGET)?.kind).toBeUndefined()
  })

  test('the request body cannot name the kind', async () => {
    pane()
    await Bun.sleep(5)
    await runFleetAction('en', { action: 'prompt', id: TARGET, text: 'mine', kind: 'notice' } as never)
    expect(lastMessageTo(TARGET)?.kind).toBeUndefined()
  })
})
