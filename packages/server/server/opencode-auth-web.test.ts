import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleOpencodeAuthRequest } from './opencode-auth-web'
import { routeCapability } from './capability-guard'

const FAKE = 'sk-test-1111111111111111'
let dir = ''
let prev: string | undefined
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-web-')); prev = process.env.OPENCODE_DIR; process.env.OPENCODE_DIR = dir })
afterEach(() => { if (prev === undefined) delete process.env.OPENCODE_DIR; else process.env.OPENCODE_DIR = prev; rmSync(dir, { recursive: true, force: true }) })

const post = (body: unknown, path = '/api/opencode/auth') =>
  handleOpencodeAuthRequest(new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

describe('/api/opencode/auth', () => {
  test('is a host-credential route behind the localShell capability', () => {
    expect(routeCapability('/api/opencode/auth')).toBe('localShell')
    expect(routeCapability('/api/opencode/auth/opencode-go')).toBe('localShell')
  })

  test('POST saves a key; GET lists the provider and never the key', async () => {
    const res = await post({ provider: 'opencode-go', key: FAKE })
    expect(res.status).toBe(200)
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))['opencode-go'].key).toBe(FAKE)
    const text = await (await handleOpencodeAuthRequest(new Request('http://x/api/opencode/auth'))).text()
    expect(text).not.toContain(FAKE)
    expect(JSON.parse(text).connected).toEqual([{ id: 'opencode-go', label: 'OpenCode Go', type: 'api' }])
  })

  test('a bad key is a 400 with a sentence, and the reply never echoes it', async () => {
    const res = await post({ provider: 'opencode-go', key: 'two words' })
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('two words')
  })

  test('DELETE removes the entry; a second DELETE is 404', async () => {
    await post({ provider: 'anthropic', key: FAKE })
    const del = () => handleOpencodeAuthRequest(new Request('http://x/api/opencode/auth/anthropic', { method: 'DELETE' }))
    expect((await del()).status).toBe(200)
    expect((await del()).status).toBe(404)
  })
})
