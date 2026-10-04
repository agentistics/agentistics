import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { openBundle, parseBundle, safeRelPath, sealBundle } from './bundle'

const dek = new Uint8Array(randomBytes(32))
const base = () => sealBundle({
  dek, kid: 'k1', createdAt: '2026-10-03T10:00:00Z', recovery: new TextEncoder().encode('RECOVERY-WRAPPED'),
  vault: { v: 2, kid: 'k1', scope: 'human', wrappers: [{ type: 'hello' }, { type: 'recovery', params: { file: 'dek.recovery' } }, { type: 'dpapi' }], retired: [{ type: 'dpapi' }], requirePresence: true },
  files: [{ path: 'vault/personal/items/it_x/v000001.meta.sealed', bytes: new TextEncoder().encode('SEALED-1') }, { path: 'github-backup.sealed', bytes: new TextEncoder().encode('SEALED-2') }],
})

describe('the vault bundle', () => {
  test('keeps only the recovery wrapper and drops machine facts; the payload hides names and count', () => {
    const b = base()
    expect((b.vault.wrappers as { type: string }[]).map(w => w.type)).toEqual(['recovery'])
    expect(b.vault.retired).toBeUndefined()
    expect(b.vault.requirePresence).toBeUndefined()
    const text = JSON.stringify(b)
    expect(text).not.toContain('it_x')
    expect(text).not.toContain('github-backup')
    expect(text).not.toContain('SEALED')
  })
  test('opens with the data key, refuses another key or a tampered payload', () => {
    const b = parseBundle(JSON.stringify(base()))!
    const o = openBundle(b, dek)
    expect(o.ok && o.files.map(f => f.path)).toEqual(['vault/personal/items/it_x/v000001.meta.sealed', 'github-backup.sealed'])
    expect(openBundle(b, new Uint8Array(32)).ok).toBe(false)
    const t = { ...b, payload: Buffer.from(Buffer.from(b.payload, 'base64').map((x, i) => (i === 20 ? x ^ 1 : x))).toString('base64') }
    expect(openBundle(t, dek).ok).toBe(false)
    expect(openBundle({ ...b, createdAt: '2026-10-04T00:00:00Z' }, dek).ok).toBe(false) // the AAD binds the date
  })
  test('a restored path stays inside the data dir and is a sealed file', () => {
    expect(safeRelPath('vault/personal/items/it_x/v000001.meta.sealed')).toBe(true)
    for (const bad of ['../x.sealed', '/etc/x.sealed', 'a//b.sealed', 'vault/vault.json', 'a\\b.sealed']) expect(safeRelPath(bad)).toBe(false)
    expect(parseBundle('{"v":2}')).toBeNull()
  })
})
