import { expect, spyOn, test } from 'bun:test'
import { touchIdProtector, readTouchIdAnswer, touchIdFailureSentence, touchIdLogLine } from './touchid'
import type { ProtectorIo } from './types'

const io = (overrides: Partial<ProtectorIo> = {}): ProtectorIo => ({
  async firstExisting(c) { return c[0] ?? null }, async which() { return null },
  async run() { return { code: 0, stdout: new TextEncoder().encode('OK'), stderr: '' } },
  async readFile() { return null }, async writeFile() {}, async removeFile() {}, async createExclusive() { return true }, ...overrides,
})
test('an unshowable Mac dialog and a rejected authentication have separate reasons', () => {
  expect(readTouchIdAnswer('ERR -1004', 0)).toMatchObject({ detail: 'touchid-no-interaction' })
  expect(readTouchIdAnswer('ERR -1', 0)).toMatchObject({ detail: 'touchid-auth-failed' })
})
test('spawn errors are unavailable, not a fictitious 60-second wait; raw reason is logged', async () => {
  const log = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const p = touchIdProtector({ vaultDir: '/v', io: io({ async run() { throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' }) } }) })
    expect(await p.probe()).toMatchObject({ ok: false, reason: 'presence-unavailable: touchid-helper-failed' })
    expect(log.mock.calls.flat().join(' ')).toContain('ENOENT')
  } finally { log.mockRestore() }
})
test('a wrapper write error returns a typed refusal instead of throwing', async () => {
  const p = touchIdProtector({ vaultDir: '/v', io: io({ async writeFile() { throw Object.assign(new Error('permission'), { code: 'EACCES' }) } }) })
  expect(await p.sealHeld!({ kek: new Uint8Array(32), fields: {} }, new Uint8Array(32), '0123456789abcdef'))
    .toEqual({ ok: false, reason: 'presence-unavailable: touchid-file-write-failed' })
})
test('native timeout and unreadable wrapper remain typed, actionable failures', async () => {
  const p = touchIdProtector({ vaultDir: '/v', io: io({ async run() { throw Object.assign(new Error('protector timed out'), { code: 'ETIMEDOUT' }) } }) })
  expect(await p.probe()).toMatchObject({ ok: false, reason: 'presence-timeout' })
  const unreadable = touchIdProtector({ vaultDir: '/v', io: io({ async readFile() { throw new Error('permission denied') } }) })
  expect(await unreadable.unwrap({ type: 'touchid', createdAt: 'x' }, '0123456789abcdef'))
    .toMatchObject({ ok: false, reason: 'presence-unavailable: touchid-file-read-failed' })
})
test('every Mac failure has an actionable sentence in both languages without commands or raw output', () => {
  for (const reason of ['presence-cancelled', 'presence-timeout', 'presence-unavailable: touchid-no-interaction',
    'presence-unavailable: touchid-helper-failed', 'presence-unavailable: touchid-auth-failed',
    'presence-unavailable: touchid-unavailable', 'presence-unavailable: touchid-not-set-up', 'presence-unavailable: touchid-locked',
    'presence-unavailable: keychain-failed', 'presence-unavailable: touchid-file-write-failed', 'presence-unavailable: touchid-file-read-failed',
    'presence-lost: file-missing', 'presence-lost: file-damaged', 'presence-lost: credential-deleted', 'presence-lost: not-reproducible', 'unknown raw reason']) {
    for (const lang of ['pt', 'en'] as const) {
      const sentence = touchIdFailureSentence(reason, lang)
      expect(sentence).toContain(lang === 'pt' ? 'senha do cofre' : 'vault password')
      expect(sentence).not.toContain('agentop'); expect(sentence).not.toContain(reason)
    }
  }
})

test('native diagnostics redact an echoed security command and never log a returned key', async () => {
  const secret = 'ab'.repeat(32)
  expect(touchIdLogLine(`security: add-generic-password -w ${secret} failed`)).not.toContain(secret)
  expect(touchIdLogLine(`security: ${secret} error`)).not.toContain(secret)
  const log = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const p = touchIdProtector({ vaultDir: '/v', io: io({ async run(cmd, args) {
      return args[0] === '-i' ? { code: 1, stdout: new TextEncoder().encode(secret), stderr: `error: -w ${secret}` }
        : { code: 0, stdout: new TextEncoder().encode('OK'), stderr: '' }
    } }) })
    expect((await p.derive!('0123456789abcdef')).ok).toBe(false)
    const lines = log.mock.calls.flat().join(' ')
    expect(lines).toContain('[redacted]'); expect(lines).not.toContain(secret)
  } finally { log.mockRestore() }
})
