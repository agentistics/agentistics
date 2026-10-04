import { describe, expect, test } from 'bun:test'
import { ensureSessionIdentityKey, sessionToken, tokenProves, verifySessionIdentity, SESSION_IDENTITY_KEY_FILE } from './session-identity'

describe('session identity', () => {
  const key = new Uint8Array(32).fill(7)
  test('a token proves exactly its own id', () => {
    const t = sessionToken(key, 'abc')
    expect(tokenProves(key, 'abc', t)).toBe(true)
    expect(tokenProves(key, 'abd', t)).toBe(false)
    expect(tokenProves(new Uint8Array(32).fill(8), 'abc', t)).toBe(false)
  })
  test('the proof is the SAME string the MCP computes (shared vector)', () => {
    // packages/mcp/session-proof.test.ts pins this exact value for the same key and id.
    expect(sessionToken(key, 's-1')).toBe('bc97f010681d2e7ad5c645e0b8c922492578cc7351241eb4ec3e609b3d686b53')
  })
  test('malformed tokens are false, never a throw', () => {
    expect(tokenProves(key, 'abc', '')).toBe(false)
    expect(tokenProves(key, 'abc', 'zz')).toBe(false)
    expect(tokenProves(key, '', sessionToken(key, ''))).toBe(false)
  })
  test('a proof made from the key file verifies, and a forged one does not', async () => {
    await ensureSessionIdentityKey()
    const raw = Buffer.from((await Bun.file(SESSION_IDENTITY_KEY_FILE).text()).trim(), 'hex')
    expect(raw.length).toBe(32)
    const t = sessionToken(raw, 's-1')
    expect(await verifySessionIdentity('s-1', t)).toBe('s-1')
    expect(await verifySessionIdentity('s-2', t)).toBeNull()
    expect(await verifySessionIdentity('s-1', 'f'.repeat(64))).toBeNull()
    expect(await verifySessionIdentity(undefined, undefined)).toBeNull()
  })
})
