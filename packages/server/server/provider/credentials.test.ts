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
