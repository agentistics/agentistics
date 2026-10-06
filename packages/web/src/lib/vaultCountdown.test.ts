import { describe, expect, test } from 'bun:test'
import { codeCountdownText, codeWindowEndsMs, remainingWords } from './vaultCountdown'

const H = 3_600_000, M = 60_000
describe('the vault code countdown', () => {
  test('only a RUNNING daily window has a clock', () => {
    const at = new Date(10 * H).toISOString()
    expect(codeWindowEndsMs({ mode: 'daily', codeNextUnlock: false, windowEndsAt: at }, 0)).toBe(10 * H)
    expect(codeWindowEndsMs({ mode: 'daily', codeNextUnlock: true, windowEndsAt: at }, 0)).toBeNull()
    expect(codeWindowEndsMs({ mode: 'always', codeNextUnlock: false, windowEndsAt: at }, 0)).toBeNull()
    expect(codeWindowEndsMs({ mode: 'daily', codeNextUnlock: false, windowEndsAt: null }, 0)).toBeNull()
    expect(codeWindowEndsMs({ mode: 'daily', codeNextUnlock: false, windowEndsAt: at }, 10 * H)).toBeNull() // expired
    expect(codeWindowEndsMs(undefined, 0)).toBeNull()
  })
  test('words round DOWN and read like the owner wrote them', () => {
    expect(remainingWords(5 * H + 12 * M + 59_000, 'pt')).toBe('5 h 12 min')
    expect(remainingWords(48 * M, 'en')).toBe('48 min')
    expect(remainingWords(3 * H, 'pt')).toBe('3 h')
    expect(remainingWords(30_000, 'pt')).toBe('menos de 1 min')
  })
  test('the sentence, and none once the window is over', () => {
    expect(codeCountdownText(5 * H + 12 * M, 0, 'pt')).toBe('Código do autenticador pedido de novo em 5 h 12 min')
    expect(codeCountdownText(5 * H + 12 * M, 0, 'en')).toBe('Authenticator code asked again in 5 h 12 min')
    expect(codeCountdownText(H, H, 'pt')).toBeNull()
    expect(codeCountdownText(null, 0, 'pt')).toBeNull()
  })
})
