import { expect, test } from 'bun:test'
import { realProtectorIo } from './io'

test('a killed protector reports a timeout instead of masquerading as a native refusal', async () => {
  await expect(realProtectorIo().run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], null, { timeoutMs: 20 }))
    .rejects.toMatchObject({ code: 'ETIMEDOUT' })
})
