import { expect, test } from 'bun:test'
import { handleHarnessInstallRoute } from './harness-install'

test('harness install refuses to run without the confirmation call', async () => {
  const res = await handleHarnessInstallRoute(
    new Request('http://localhost/api/harnesses/codex/install', { method: 'POST', body: '{}' }), 'codex', 'install',
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'confirmation_required' })
})

test('harness install streams a plain-language failure and releases the lock', async () => {
  const runner = async (_argv: string[], _line: (line: string) => void, _timeout: number) => 1
  const res = await handleHarnessInstallRoute(
    new Request('http://localhost/api/harnesses/codex/install', { method: 'POST', body: JSON.stringify({ confirmed: true }) }),
    'codex', 'install', runner,
  )
  const text = await res.text()
  expect(text).toContain('A instalação não terminou')
  const retry = await handleHarnessInstallRoute(
    new Request('http://localhost/api/harnesses/codex/install', { method: 'POST', body: JSON.stringify({ confirmed: true }) }),
    'codex', 'install', runner,
  )
  expect(retry.status).toBe(200)
})
