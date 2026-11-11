import { describe, expect, test } from 'bun:test'
import { nayWorkingDirConflict } from './nay-route-errors'

describe('POST /api/fleet/nay route errors', () => {
  test('a deleted folder is a 409 with the Settings → Chat sentence', async () => {
    const en = await nayWorkingDirConflict(new Request('http://x/api/fleet/nay?lang=en'), '/tmp/deleted').json() as { ok: boolean; message: string }
    expect(en).toEqual({ ok: false, message: 'the agent folder /tmp/deleted no longer exists — pick another in Settings → Chat' })
    expect(nayWorkingDirConflict(new Request('http://x/api/fleet/nay?lang=pt'), '/tmp/apagada').status).toBe(409)
  })
})
