import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileContentStore } from './content-store.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agt-b4-content-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createFileContentStore', () => {
  test('put then get round-trips the exact text, sha256-addressed', async () => {
    const store = createFileContentStore(dir)
    const ref = await store.put('hello, world')
    expect(ref).not.toBeNull()
    expect(ref?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(ref?.bytes).toBe(Buffer.byteLength('hello, world'))
    expect(await store.get(ref!.sha256)).toBe('hello, world')
  })

  test('is content-addressed and idempotent: putting the same text twice yields the same ref', async () => {
    const store = createFileContentStore(dir)
    const a = await store.put('same text')
    const b = await store.put('same text')
    expect(a?.sha256).toBe(b?.sha256)
  })

  test('the stored file is written with mode 0600', async () => {
    const store = createFileContentStore(dir)
    const ref = await store.put('mode check')
    const path = join(dir, ref!.sha256.slice(0, 2), ref!.sha256.slice(2, 4), ref!.sha256)
    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)
  })

  test('the fan-out directories are 0700', async () => {
    const store = createFileContentStore(dir)
    const ref = await store.put('dir mode check')
    const subDir = join(dir, ref!.sha256.slice(0, 2), ref!.sha256.slice(2, 4))
    const info = await stat(subDir)
    expect(info.mode & 0o777).toBe(0o700)
  })

  test('get rejects a sha that is not exactly 64 lowercase hex chars, without touching the filesystem', async () => {
    const store = createFileContentStore(dir)
    expect(await store.get('not-a-sha')).toBeNull()
    expect(await store.get('a'.repeat(63))).toBeNull()
    expect(await store.get('A'.repeat(64))).toBeNull() // uppercase is not accepted
    expect(await store.get('../../../../etc/passwd'.padEnd(64, '0'))).toBeNull()
  })

  test('get on a sha that was never written is null, never a throw', async () => {
    const store = createFileContentStore(dir)
    expect(await store.get('0'.repeat(64))).toBeNull()
  })

  test('put never throws — a store rooted at an unwritable path resolves to null', async () => {
    const store = createFileContentStore('/proc/agentistics-content-store-should-not-exist')
    const ref = await store.put('will not land')
    expect(ref).toBeNull()
  })
})
