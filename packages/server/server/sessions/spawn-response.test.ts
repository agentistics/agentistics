import { describe, expect, test } from 'bun:test'
import { spawnResponse } from './fleet-web'

describe('spawnResponse — the CLI status line never rides on a refusal', () => {
  test('a failure with the CLI tail is stripped, EN and PT', () => {
    expect(spawnResponse({ ok: false, message: 'claude is not on the PATH. Started s2 in the background.' }, 'en').message).toBe('Claude is not on the PATH.')
    expect(spawnResponse({ ok: false, message: 'claude não está no PATH. s2 iniciada em background.' }, 'pt').message).toBe('Claude não está no PATH.')
  })
  test('a success keeps the host sentence untouched', () => {
    expect(spawnResponse({ ok: true, id: 's2', message: 's2 started in the background.' }, 'en')).toEqual({ ok: true, id: 's2', message: 's2 started in the background.' })
  })
  test('a tail-only failure falls back to the original text', () => {
    expect(spawnResponse({ ok: false, message: 'Started s2 in the background.' }, 'en').message).toBe('Started s2 in the background.')
  })
})
