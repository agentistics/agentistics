import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grantMarkerExists } from './cli-vault'
import { postToolDecision, withheldAnswer } from './vault/hook-rewrite'

describe('PostToolUse grant history fallback', () => {
  test('an existing marker withholds output when the service cannot answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentistics-cli-marker-'))
    const marker = join(dir, 'grant-session')
    await writeFile(marker, '', { mode: 0o600 })
    const hadGrant = await grantMarkerExists(marker)
    expect(hadGrant).toBe(true)
    expect(postToolDecision('output', undefined, hadGrant)).toBe(withheldAnswer())
  })

  test('ENOENT is handled without throwing and permits output for an ungranted session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentistics-cli-marker-'))
    const hadGrant = await grantMarkerExists(join(dir, 'missing'))
    expect(hadGrant).toBe(false)
    expect(postToolDecision('output', undefined, hadGrant)).toBeNull()
  })

  test('unexpected filesystem errors remain fail-closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentistics-cli-marker-'))
    const file = join(dir, 'file')
    await writeFile(file, '')
    // Looking beneath a regular file yields ENOTDIR rather than ENOENT.
    const hadGrant = await grantMarkerExists(join(file, 'grant-session'))
    expect(hadGrant).toBe(true)
    expect(postToolDecision('output', undefined, hadGrant)).toBe(withheldAnswer())
  })
})
