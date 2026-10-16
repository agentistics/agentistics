import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { finishChatRead } from './chat-web'
import { recordComposerMessage } from './composer-message'

const wrap = (text: string) => `<pasted_content id="long">\n${text}\n</pasted_content id="long">`

// Tests run under agentop run with throwaway HOME; config also isolates Bun's data dir.
// Each test owns only these randomly keyed fingerprint files.
test('chat payload preserves typed rendering with images, after linking and reopening', async () => {
  const originalRow = randomUUID()
  const conversation = randomUUID()
  const reopenedRow = randomUUID()
  const prose = 'A long typed message with enough detail to trigger the harness paste wrapper.\n'.repeat(30).trim()
  try {
    await recordComposerMessage(originalRow, `/uploads/example.png\n${prose}`)
    const linked = await finishChatRead(originalRow, conversation, {
      turns: [{ role: 'user', text: `[Image #42]${wrap(prose)}` }],
    }, true, 'en', originalRow)
    expect(linked.turns[0]?.composer).toBe(true)

    const reopened = await finishChatRead(reopenedRow, conversation, {
      turns: [
        { role: 'user', text: `[Image #42]${wrap(prose)}` },
        { role: 'user', text: wrap('An unrelated pasted block from the terminal') },
        { role: 'assistant', text: `[Image #42]${wrap(prose)}` },
      ],
    }, true, 'pt', reopenedRow)
    expect(reopened.turns.map(turn => turn.composer)).toEqual([true, undefined, undefined])
    expect(reopened.turns[0]?.text).toBe(`[Image #42]${wrap(prose)}`)
  } finally {
    for (const id of [originalRow, conversation, reopenedRow]) {
      const filename = `${createHash('sha256').update(id).digest('hex')}.log`
      await rm(join(AGENTISTICS_DATA_DIR, 'composer-messages', filename), { force: true })
    }
  }
})

test('chat payload distinguishes a typed long text-only message from an external paste', async () => {
  const row = randomUUID()
  const prose = 'These are the words the owner typed without an image.\n'.repeat(40).trim()
  try {
    await recordComposerMessage(row, prose)
    const chat = await finishChatRead(row, row, {
      turns: [
        { role: 'user', text: wrap(prose) },
        { role: 'user', text: wrap('A separate external paste') },
      ],
    }, true, 'en')
    expect(chat.turns.map(turn => turn.composer)).toEqual([true, undefined])
  } finally {
    const filename = `${createHash('sha256').update(row).digest('hex')}.log`
    await rm(join(AGENTISTICS_DATA_DIR, 'composer-messages', filename), { force: true })
  }
})
