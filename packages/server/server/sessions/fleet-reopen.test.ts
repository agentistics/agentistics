import { afterEach, expect, spyOn, test } from 'bun:test'
import { __setFleetHostForTest, runFleetAction } from './fleet-web'
import { SessionNotice } from './action-error'

const errors: ReturnType<typeof spyOn>[] = []
afterEach(() => {
  __setFleetHostForTest('en', null)
  __setFleetHostForTest('pt', null)
  for (const error of errors.splice(0)) error.mockRestore()
})

function host(resumeSession: (req?: unknown) => Promise<unknown>) {
  return {
    sessions: async () => ({ sessions: [{ id: 'fallen', harness: 'claude', cwd: '/project', title: 'Motor', actionable: true, resume: { sessionId: 'conversation', title: 'Motor' } }] }),
    resumeSession,
  } as never
}

test('an unsupported action returns a sentence instead of falling through to undefined', async () => {
  __setFleetHostForTest('en', host(async () => ({ ok: true })))
  const out = await runFleetAction('en', { action: 'reopen', id: 'fallen' } as never)
  expect(out).toMatchObject({ ok: false, message: expect.stringContaining('not supported') })
})

for (const lang of ['en', 'pt'] as const) {
  test(`a throwing resume returns a localized sentence and logs the failure (${lang})`, async () => {
    const log = spyOn(console, 'error').mockImplementation(() => {})
    errors.push(log)
    __setFleetHostForTest(lang, host(async () => { throw new TypeError('internal resume failure') }))
    const out = await runFleetAction(lang, { action: 'resume', id: 'fallen' })
    expect(out.ok).toBe(false)
    expect(out.message).toContain(lang === 'pt' ? 'Não foi possível' : 'Could not')
    expect(out.message).not.toContain('internal resume failure')
    expect(log).toHaveBeenCalled()
  })
}

test('an undefined resume result is diagnosed without exposing a JavaScript error', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  errors.push(log)
  __setFleetHostForTest('en', host(async () => undefined))
  expect(await runFleetAction('en', { action: 'resume', id: 'fallen' })).toMatchObject({ ok: false, message: expect.any(String) })
  expect(log).toHaveBeenCalled()
})

test('a resume result keeps the replacement id and account refusal', async () => {
  __setFleetHostForTest('en', host(async () => ({ ok: true, id: 'replacement', message: 'Started' })))
  expect(await runFleetAction('en', { action: 'resume', id: 'fallen' })).toEqual({ ok: true, id: 'replacement', message: 'Started' })
  __setFleetHostForTest('en', host(async () => ({ ok: false, message: 'Signed out', accountRefusal: 'account_signed_out' })))
  expect(await runFleetAction('en', { action: 'resume', id: 'fallen' })).toEqual({ ok: false, message: 'Signed out', code: 'account_signed_out' })
})

test('a notice thrown by the resume (a reopen already in progress) keeps its own sentence', async () => {
  __setFleetHostForTest('en', host(async () => { throw new SessionNotice('Conversation reopen is already in progress; retry shortly.') }))
  expect(await runFleetAction('en', { action: 'resume', id: 'fallen' })).toEqual({ ok: false, message: 'Conversation reopen is already in progress; retry shortly.' })
})

test('a memory-gate refusal says so (memoryBudget), and "reopen anyway" reaches the resume as force', async () => {
  const seen: unknown[] = []
  const refusal = { ok: false, message: 'Not enough memory to start another session…', admission: { code: 'memory_budget', refusal: {}, message: 'x' } }
  __setFleetHostForTest('en', host(async (req?: unknown) => { seen.push(req); return refusal }))
  expect(await runFleetAction('en', { action: 'resume', id: 'fallen' })).toEqual({ ok: false, message: refusal.message, memoryBudget: true })
  expect((seen[0] as { force?: boolean }).force).toBeUndefined()
  __setFleetHostForTest('en', host(async (req?: unknown) => { seen.push(req); return { ok: true, id: 'r2', message: 'Started' } }))
  expect(await runFleetAction('en', { action: 'resume', id: 'fallen', force: true })).toEqual({ ok: true, id: 'r2', message: 'Started' })
  expect((seen[1] as { force?: boolean }).force).toBe(true)
})
