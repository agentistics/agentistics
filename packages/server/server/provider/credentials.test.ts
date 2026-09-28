import { describe, test, expect, afterEach } from 'bun:test'
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerKeyFile } from '../config.ts'
import { fingerprintOf } from './credential-plan.ts'
import {
  credentialStatus,
  removeCredential,
  resolveCredential,
  storeCredential,
} from './credentials.ts'

// A key shaped exactly like a real one, built at runtime — never a literal that could be mistaken
// for a live secret in this file's history.
const FAKE_KEY = 'sk-ant-' + 'test' + 'x'.repeat(40)
const OTHER_FAKE_KEY = 'sk-ant-' + 'other' + 'y'.repeat(40)

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-provider-keys-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

describe('storeCredential', () => {
  test('refuses a badly-shaped value before touching disk', async () => {
    await withTempDir(async (dir) => {
      const result = await storeCredential('anthropic', 'not-a-key', { dir })
      expect(result).toEqual({ ok: false, reason: 'invalid-shape', shape: 'prefix' })
      // Nothing was created.
      await expect(readdir(dir)).resolves.toEqual([])
    })
  })

  test('first write: directory 0700, file 0600, fingerprint reported, no previous', async () => {
    await withTempDir(async (dir) => {
      const result = await storeCredential('anthropic', FAKE_KEY, { dir })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.fingerprint).toBe(fingerprintOf(FAKE_KEY))
      expect(result.previous).toBeNull()

      expect(await modeOf(dir)).toBe(0o700)
      expect(await modeOf(result.path)).toBe(0o600)
    })
  })

  test('a second write without replace refuses with the existing fingerprint, and changes nothing', async () => {
    await withTempDir(async (dir) => {
      const first = await storeCredential('anthropic', FAKE_KEY, { dir })
      if (!first.ok) throw new Error('unreachable')

      const second = await storeCredential('anthropic', OTHER_FAKE_KEY, { dir })
      expect(second).toEqual({ ok: false, reason: 'exists', previous: first.fingerprint })

      const resolved = await resolveCredential('anthropic', { dir })
      expect(resolved.ok).toBe(true)
      if (resolved.ok) expect(resolved.handle.reveal()).toBe(FAKE_KEY)
    })
  })

  test('rotation with replace: mode stays 0600/0700, fingerprint moves old -> new', async () => {
    await withTempDir(async (dir) => {
      const first = await storeCredential('anthropic', FAKE_KEY, { dir })
      if (!first.ok) throw new Error('unreachable')

      const second = await storeCredential('anthropic', OTHER_FAKE_KEY, { dir, replace: true })
      expect(second.ok).toBe(true)
      if (!second.ok) throw new Error('unreachable')
      expect(second.previous).toBe(first.fingerprint)
      expect(second.fingerprint).toBe(fingerprintOf(OTHER_FAKE_KEY))
      expect(second.fingerprint).not.toBe(first.fingerprint)

      expect(await modeOf(dir)).toBe(0o700)
      expect(await modeOf(second.path)).toBe(0o600)

      const resolved = await resolveCredential('anthropic', { dir })
      expect(resolved.ok).toBe(true)
      if (resolved.ok) expect(resolved.handle.reveal()).toBe(OTHER_FAKE_KEY)
    })
  })

  test('an injected failure between write and rename leaves no tmp file and the previous key intact', async () => {
    await withTempDir(async (dir) => {
      const first = await storeCredential('anthropic', FAKE_KEY, { dir })
      if (!first.ok) throw new Error('unreachable')

      const result = await storeCredential('anthropic', OTHER_FAKE_KEY, {
        dir,
        replace: true,
        beforeRename: () => { throw new Error('simulated crash before rename') },
      })
      expect(result).toEqual({ ok: false, reason: 'write-failed' })

      // No tmp file left behind.
      const entries = await readdir(dir)
      expect(entries.some((e) => e.startsWith('.tmp-'))).toBe(false)

      // The original key is untouched — the rename never happened.
      const resolved = await resolveCredential('anthropic', { dir })
      expect(resolved.ok).toBe(true)
      if (resolved.ok) {
        expect(resolved.handle.reveal()).toBe(FAKE_KEY)
        expect(resolved.handle.fingerprint).toBe(first.fingerprint)
      }
    })
  })

  test('storeCredential never returns the value on any success or failure path', async () => {
    await withTempDir(async (dir) => {
      const ok = await storeCredential('anthropic', FAKE_KEY, { dir })
      expect(JSON.stringify(ok)).not.toContain(FAKE_KEY)

      const exists = await storeCredential('anthropic', OTHER_FAKE_KEY, { dir })
      expect(JSON.stringify(exists)).not.toContain(OTHER_FAKE_KEY)
      expect(JSON.stringify(exists)).not.toContain(FAKE_KEY)
    })
  })
})

describe('resolveCredential', () => {
  test('absent when nothing was ever stored', async () => {
    await withTempDir(async (dir) => {
      expect(await resolveCredential('anthropic', { dir })).toEqual({ ok: false, reason: 'absent' })
    })
  })

  test('a mode widened by e.g. umask is refused WITHOUT reading the content', async () => {
    await withTempDir(async (dir) => {
      const stored = await storeCredential('anthropic', FAKE_KEY, { dir })
      if (!stored.ok) throw new Error('unreachable')
      await chmod(stored.path, 0o644)

      const resolved = await resolveCredential('anthropic', { dir })
      expect(resolved).toEqual({ ok: false, reason: 'permissions-too-open' })
    })
  })

  test('malformed content on disk reads as unreadable', async () => {
    await withTempDir(async (dir) => {
      const path = providerKeyFile('anthropic', dir)
      await writeFile(path, '{ not json', { mode: 0o600 })
      await chmod(path, 0o600)
      expect(await resolveCredential('anthropic', { dir })).toEqual({ ok: false, reason: 'unreadable' })
    })
  })
})

describe('credentialStatus', () => {
  test('absent', async () => {
    await withTempDir(async (dir) => {
      const status = await credentialStatus('anthropic', { dir })
      expect(status.state).toBe('absent')
      expect(status.fingerprint).toBeUndefined()
    })
  })

  test('present, with mode/storedAt/fingerprint, never the value', async () => {
    await withTempDir(async (dir) => {
      const stored = await storeCredential('anthropic', FAKE_KEY, { dir })
      if (!stored.ok) throw new Error('unreachable')

      const status = await credentialStatus('anthropic', { dir })
      expect(status.state).toBe('present')
      expect(status.mode).toBe('0600')
      expect(status.fingerprint).toBe(stored.fingerprint)
      expect(typeof status.storedAt).toBe('string')
      expect(JSON.stringify(status)).not.toContain(FAKE_KEY)
    })
  })

  test('readContent: false answers from the stat alone — no fingerprint, no storedAt', async () => {
    await withTempDir(async (dir) => {
      const stored = await storeCredential('anthropic', FAKE_KEY, { dir })
      if (!stored.ok) throw new Error('unreachable')

      const status = await credentialStatus('anthropic', { dir, readContent: false })
      expect(status.state).toBe('present')
      expect(status.mode).toBe('0600')
      expect(status.fingerprint).toBeUndefined()
      expect(status.storedAt).toBeUndefined()
    })
  })

  test('permissions-too-open names the mode', async () => {
    await withTempDir(async (dir) => {
      const stored = await storeCredential('anthropic', FAKE_KEY, { dir })
      if (!stored.ok) throw new Error('unreachable')
      await chmod(stored.path, 0o644)

      const status = await credentialStatus('anthropic', { dir })
      expect(status.state).toBe('permissions-too-open')
      expect(status.mode).toBe('0644')
    })
  })
})

describe('removeCredential', () => {
  test('removes the file, prunes the now-empty directory, reports the fingerprint removed', async () => {
    await withTempDir(async (dir) => {
      const stored = await storeCredential('anthropic', FAKE_KEY, { dir })
      if (!stored.ok) throw new Error('unreachable')

      const result = await removeCredential('anthropic', { dir })
      expect(result).toEqual({ removed: true, fingerprint: stored.fingerprint, prunedDir: true })

      // set recreates exactly what remove deleted (§6.5).
      const after = await storeCredential('anthropic', FAKE_KEY, { dir })
      expect(after.ok).toBe(true)
    })
  })

  test('removing an absent key is idempotent, never a throw', async () => {
    await withTempDir(async (dir) => {
      expect(await removeCredential('anthropic', { dir })).toEqual({ removed: false })
    })
  })

  test('a second remove after the first is also a no-op', async () => {
    await withTempDir(async (dir) => {
      const stored = await storeCredential('anthropic', FAKE_KEY, { dir })
      if (!stored.ok) throw new Error('unreachable')
      await removeCredential('anthropic', { dir })
      expect(await removeCredential('anthropic', { dir })).toEqual({ removed: false })
    })
  })

  test('never returns the value it removed', async () => {
    await withTempDir(async (dir) => {
      const stored = await storeCredential('anthropic', FAKE_KEY, { dir })
      if (!stored.ok) throw new Error('unreachable')
      const result = await removeCredential('anthropic', { dir })
      expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
    })
  })
})

describe('§6.4 — a subscription credential lying around is never touched, and env is never read', () => {
  const ORIGINAL_ENV = process.env.ANTHROPIC_API_KEY

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_ENV
  })

  test(
    'ANTHROPIC_API_KEY set + a plausible OAuth credentials file present + no provider key stored '
      + '-> resolveCredential still answers absent, and nothing it returns names either secret',
    async () => {
      const FAKE_ENV_KEY = 'sk-ant-' + 'envleak' + 'z'.repeat(40)
      const FAKE_OAUTH_TOKEN = 'sk-ant-oat01-' + 'q'.repeat(60)
      process.env.ANTHROPIC_API_KEY = FAKE_ENV_KEY

      await withTempDir(async (fakeHome) => {
        // A plausible ~/.credentials.json sitting right next to (not inside) our provider-keys
        // directory — this module has no path to it at all, so the only way it could leak is by
        // reading process.env or wandering outside `dir`, neither of which it does.
        await writeFile(
          join(fakeHome, '.credentials.json'),
          JSON.stringify({ claudeAiOauth: { accessToken: FAKE_OAUTH_TOKEN } }),
        )

        await withTempDir(async (providerKeysDir) => {
          const resolved = await resolveCredential('anthropic', { dir: providerKeysDir })
          expect(resolved).toEqual({ ok: false, reason: 'absent' })

          const serialized = JSON.stringify(resolved)
          expect(serialized).not.toContain(FAKE_ENV_KEY)
          expect(serialized).not.toContain(FAKE_OAUTH_TOKEN)

          const status = await credentialStatus('anthropic', { dir: providerKeysDir })
          const serializedStatus = JSON.stringify(status)
          expect(serializedStatus).not.toContain(FAKE_ENV_KEY)
          expect(serializedStatus).not.toContain(FAKE_OAUTH_TOKEN)
        })

        // The fake credentials file was never read or moved — confirming this module never went
        // looking for it.
        const stillThere = await readFile(join(fakeHome, '.credentials.json'), 'utf-8')
        expect(stillThere).toContain(FAKE_OAUTH_TOKEN)
      })
    },
  )
})

// ── B5a — endpoint records ──────────────────────────────────────────────────────────────────────

import {
  readEndpointCredential,
  resolveCredentialRef,
  storeEndpointCredential,
} from './credentials.ts'

const FAKE_EP_KEY = 'sk-or-' + 'test' + 'z'.repeat(40)

describe('storeEndpointCredential / readEndpointCredential', () => {
  test('writes 0600 in a 0700 dir, with the base URL beside the key, atomically (no .tmp left)', async () => {
    await withTempDir(async (dir) => {
      const r = await storeEndpointCredential('openrouter', { baseUrl: 'https://openrouter.ai/api/v1/', key: FAKE_EP_KEY }, { dir })
      expect(r.ok).toBe(true)
      const path = providerKeyFile('openrouter', dir)
      expect(await modeOf(path)).toBe(0o600)
      expect(await modeOf(dir)).toBe(0o700)
      expect((await readdir(dir)).filter(n => n.startsWith('.tmp-'))).toEqual([])
      const doc = JSON.parse(await readFile(path, 'utf-8'))
      expect(doc).toMatchObject({ provider: 'openai-compatible', endpoint: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })
      const read = await readEndpointCredential('openrouter', { dir })
      if (!read.ok) throw new Error('expected ok')
      expect(read.baseUrl).toBe('https://openrouter.ai/api/v1')
      expect(read.handle?.fingerprint).toBe(fingerprintOf(FAKE_EP_KEY))
    })
  })

  test('refuses a bad base URL or a missing key before touching disk; keyless only for ollama', async () => {
    await withTempDir(async (dir) => {
      expect(await storeEndpointCredential('openai', { baseUrl: 'http://evil.example/v1', key: FAKE_EP_KEY }, { dir }))
        .toEqual({ ok: false, reason: 'invalid-base-url', baseUrl: 'insecure-remote' })
      expect(await storeEndpointCredential('openai', { baseUrl: 'https://api.openai.com/v1', key: null }, { dir }))
        .toEqual({ ok: false, reason: 'key-required' })
      expect(await readdir(dir)).toEqual([])
      const keyless = await storeEndpointCredential('ollama', { baseUrl: 'http://localhost:11434/v1', key: null }, { dir })
      expect(keyless.ok).toBe(true)
      const read = await readEndpointCredential('ollama', { dir })
      expect(read.ok && read.handle === null).toBe(true)
    })
  })

  test('an existing record is not replaced without replace; a failed rename leaves the old one intact', async () => {
    await withTempDir(async (dir) => {
      await storeEndpointCredential('openai', { baseUrl: 'https://api.openai.com/v1', key: FAKE_EP_KEY }, { dir })
      const again = await storeEndpointCredential('openai', { baseUrl: 'https://api.openai.com/v1', key: FAKE_EP_KEY + 'b' }, { dir })
      expect(again.ok).toBe(false)
      const crashed = await storeEndpointCredential('openai', { baseUrl: 'https://api.openai.com/v1', key: FAKE_EP_KEY + 'b' }, {
        dir, replace: true, beforeRename: () => { throw new Error('simulated crash') },
      })
      expect(crashed).toEqual({ ok: false, reason: 'write-failed' })
      const read = await readEndpointCredential('openai', { dir })
      expect(read.ok && read.handle?.fingerprint).toBe(fingerprintOf(FAKE_EP_KEY))
      expect((await readdir(dir)).filter(n => n.startsWith('.tmp-'))).toEqual([])
    })
  })

  test('a too-open file is refused on the stat alone', async () => {
    await withTempDir(async (dir) => {
      await storeEndpointCredential('openai', { baseUrl: 'https://api.openai.com/v1', key: FAKE_EP_KEY }, { dir })
      await chmod(providerKeyFile('openai', dir), 0o644)
      expect(await readEndpointCredential('openai', { dir })).toEqual({ ok: false, reason: 'permissions-too-open' })
      const st = await credentialStatus('openai', { dir })
      expect(st.state).toBe('permissions-too-open')
    })
  })

  test('status shows the base URL, fingerprint and last 4 — never the key', async () => {
    await withTempDir(async (dir) => {
      await storeEndpointCredential('deepseek', { baseUrl: 'https://api.deepseek.com/v1', key: FAKE_EP_KEY }, { dir })
      const st = await credentialStatus('deepseek', { dir })
      expect(st).toMatchObject({ state: 'present', baseUrl: 'https://api.deepseek.com/v1', fingerprint: fingerprintOf(FAKE_EP_KEY), last4: FAKE_EP_KEY.slice(-4) })
      expect(JSON.stringify(st)).not.toContain(FAKE_EP_KEY)
      const removed = await removeCredential('deepseek', { dir })
      expect(removed).toMatchObject({ removed: true, fingerprint: fingerprintOf(FAKE_EP_KEY) })
    })
  })
})

describe('resolveCredentialRef — the one ref mapping', () => {
  test('maps {openai-compatible, endpoint}; a keyless endpoint answers absent; mismatched pairs are wrong-provider', async () => {
    await withTempDir(async (dir) => {
      await storeEndpointCredential('openrouter', { baseUrl: 'https://openrouter.ai/api/v1', key: FAKE_EP_KEY }, { dir })
      await storeEndpointCredential('ollama', { baseUrl: 'http://localhost:11434/v1', key: null }, { dir })

      const ok = await resolveCredentialRef({ provider: 'openai-compatible', id: 'openrouter' }, { dir })
      expect(ok.ok && ok.handle.provider).toBe('openai-compatible')
      expect(ok.ok && ok.handle.reveal()).toBe(FAKE_EP_KEY)

      expect(await resolveCredentialRef({ provider: 'openai-compatible', id: 'ollama' }, { dir })).toEqual({ ok: false, reason: 'absent' })
      expect(await resolveCredentialRef({ provider: 'openai-compatible', id: 'deepseek' }, { dir })).toEqual({ ok: false, reason: 'absent' })

      for (const ref of [
        { provider: 'openai' as const, id: 'openrouter' },
        { provider: 'openai-compatible' as const, id: 'anthropic' },
        { provider: 'openai-compatible' as const, id: '../anthropic' },
        // a vendor `ProviderId` this store still never keys by (google IS keyed now — see below)
        { provider: 'moonshot' as const, id: 'default' },
      ]) {
        expect(await resolveCredentialRef(ref, { dir })).toEqual({ ok: false, reason: 'wrong-provider' })
      }
    })
  })
})

// B5b — Google's Gemini key: the same one-key-per-vendor record as Anthropic's, under its own file.
const FAKE_GOOGLE_KEY = 'AIza' + 'Test' + 'x'.repeat(31)

describe('the Google key (B5b) — a second key vendor over the same store', () => {
  test('stored 0600 in provider-keys/google.json, resolved to a handle that names google and hides the key', async () => {
    await withTempDir(async (dir) => {
      const stored = await storeCredential('google', FAKE_GOOGLE_KEY, { dir })
      if (!stored.ok) throw new Error('unreachable')
      expect(stored.path).toBe(providerKeyFile('google', dir))
      expect(await modeOf(stored.path)).toBe(0o600)
      expect(await modeOf(dir)).toBe(0o700)

      const resolved = await resolveCredential('google', { dir })
      if (!resolved.ok) throw new Error('unreachable')
      expect(resolved.handle.provider).toBe('google')
      expect(resolved.handle.reveal()).toBe(FAKE_GOOGLE_KEY)
      expect(String(resolved.handle)).toBe(`[credential google ${fingerprintOf(FAKE_GOOGLE_KEY)}]`)
      expect(JSON.stringify(resolved.handle)).not.toContain(FAKE_GOOGLE_KEY)
    })
  })

  test('the two vendors never read each other\'s record, and never collide on disk', async () => {
    await withTempDir(async (dir) => {
      await storeCredential('anthropic', FAKE_KEY, { dir })
      await storeCredential('google', FAKE_GOOGLE_KEY, { dir })
      expect((await readdir(dir)).sort()).toEqual(['anthropic.json', 'google.json'])
      const a = await resolveCredential('anthropic', { dir })
      const g = await resolveCredential('google', { dir })
      expect(a.ok && a.handle.reveal()).toBe(FAKE_KEY)
      expect(g.ok && g.handle.reveal()).toBe(FAKE_GOOGLE_KEY)

      // a record copied under the wrong name is `wrong-provider`, never handed to the other vendor
      await writeFile(providerKeyFile('google', dir), await readFile(providerKeyFile('anthropic', dir), 'utf8'), { mode: 0o600 })
      expect(await resolveCredential('google', { dir })).toEqual({ ok: false, reason: 'wrong-provider' })
    })
  })

  test('shape: an Anthropic key is refused for Google (it would be sent to another host), and a Google key for Anthropic', async () => {
    await withTempDir(async (dir) => {
      expect(await storeCredential('google', FAKE_KEY, { dir })).toEqual({ ok: false, reason: 'invalid-shape', shape: 'foreign-prefix' })
      expect(await storeCredential('anthropic', FAKE_GOOGLE_KEY, { dir })).toEqual({ ok: false, reason: 'invalid-shape', shape: 'prefix' })
      expect(await storeCredential('google', 'AIza short', { dir })).toEqual({ ok: false, reason: 'invalid-shape', shape: 'whitespace' })
      expect(await storeCredential('google', 'AIzaShort', { dir })).toEqual({ ok: false, reason: 'invalid-shape', shape: 'too-short' })
      await expect(readdir(dir)).resolves.toEqual([])
    })
  })

  test('a second write without replace refuses; rotation reports old -> new; status shows fingerprint and last 4 only', async () => {
    await withTempDir(async (dir) => {
      const first = await storeCredential('google', FAKE_GOOGLE_KEY, { dir })
      if (!first.ok) throw new Error('unreachable')
      expect(await storeCredential('google', FAKE_GOOGLE_KEY + 'z', { dir })).toEqual({ ok: false, reason: 'exists', previous: first.fingerprint })
      const rotated = await storeCredential('google', FAKE_GOOGLE_KEY + 'z', { dir, replace: true })
      expect(rotated.ok && rotated.previous).toBe(first.fingerprint)

      const st = await credentialStatus('google', { dir })
      expect(st).toMatchObject({ provider: 'google', state: 'present', fingerprint: fingerprintOf(FAKE_GOOGLE_KEY + 'z'), last4: (FAKE_GOOGLE_KEY + 'z').slice(-4) })
      expect(st.baseUrl).toBeUndefined() // a vendor has no base URL to configure
      expect(JSON.stringify(st)).not.toContain(FAKE_GOOGLE_KEY)

      const removed = await removeCredential('google', { dir })
      expect(removed).toMatchObject({ removed: true, fingerprint: fingerprintOf(FAKE_GOOGLE_KEY + 'z') })
      expect((await credentialStatus('google', { dir })).state).toBe('absent')
    })
  })

  test('a too-open google file is refused on the stat alone', async () => {
    await withTempDir(async (dir) => {
      await storeCredential('google', FAKE_GOOGLE_KEY, { dir })
      await chmod(providerKeyFile('google', dir), 0o644)
      expect(await resolveCredential('google', { dir })).toEqual({ ok: false, reason: 'permissions-too-open' })
    })
  })

  test('resolveCredentialRef maps {google, *} to the Google key, and only that ref', async () => {
    await withTempDir(async (dir) => {
      expect(await resolveCredentialRef({ provider: 'google', id: 'default' }, { dir })).toEqual({ ok: false, reason: 'absent' })
      await storeCredential('google', FAKE_GOOGLE_KEY, { dir })
      await storeCredential('anthropic', FAKE_KEY, { dir })
      const g = await resolveCredentialRef({ provider: 'google', id: 'default' }, { dir })
      expect(g.ok && g.handle.provider).toBe('google')
      expect(g.ok && g.handle.reveal()).toBe(FAKE_GOOGLE_KEY)
      const a = await resolveCredentialRef({ provider: 'anthropic', id: 'default' }, { dir })
      expect(a.ok && a.handle.reveal()).toBe(FAKE_KEY)
    })
  })
})
