/**
 * vault/io.ts — the REAL edges `@agentistics/vault` is pure over: running a protector's CLI with a
 * payload on stdin (`ProtectorIo`), and the filesystem calls the atomic writer and the migration are
 * made of (`SecretFs`).
 *
 * Nothing here logs, and nothing here puts a payload in an argv: `run` takes the secret as `stdin`
 * and writes it to the child's pipe.
 */
import { open, mkdir, rename, chmod, readFile, unlink, lstat, readdir, link } from 'node:fs/promises'
import { dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { writePrivateAtomic, type ProtectorIo, type RunResult, type SecretFs } from '@agentistics/vault'

export const realSecretFs: SecretFs = {
  async mkdirp(dir, mode) {
    await mkdir(dir, { recursive: true, mode })
  },
  async openExclusive(path, mode) {
    const fh = await open(path, 'wx', mode)
    return {
      async write(data) { await fh.writeFile(data) },
      async sync() { await fh.sync() },
      async close() { await fh.close() },
    }
  },
  async openExisting(path) {
    const fh = await open(path, 'r+')
    return {
      async write(data) { await fh.write(data, 0, data.length, 0) },
      async sync() { await fh.sync() },
      async close() { await fh.close() },
    }
  },
  async rename(from, to) { await rename(from, to) },
  async chmod(path, mode) { await chmod(path, mode) },
  async fsyncDir(dir) {
    // Not every platform lets a directory be opened for fsync (Windows); a failure here costs
    // durability of the rename across a power cut, never correctness of what was written.
    try {
      const fh = await open(dir, 'r')
      try { await fh.sync() } finally { await fh.close() }
    } catch { /* see above */ }
  },
  async readFile(path) {
    try { return new Uint8Array(await readFile(path)) } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  async unlink(path) {
    try { await unlink(path) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  },
  async lstat(path) {
    try {
      const s = await lstat(path)
      return { mode: s.mode & 0o777, size: s.size, mtimeMs: s.mtimeMs }
    } catch { return null }
  },
  async readdir(dir) {
    try { return await readdir(dir) } catch { return [] }
  },
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
}

async function readAll(stream: ReadableStream<Uint8Array> | null | undefined): Promise<Uint8Array> {
  if (!stream) return new Uint8Array()
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export function realProtectorIo(): ProtectorIo {
  return {
    async run(cmd, args, stdin, opts): Promise<RunResult> {
      const proc = Bun.spawn([cmd, ...args], {
        stdin: stdin ? 'pipe' : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        // The vault never inherits a terminal: a protector that wants a prompt (the Keychain)
        // raises its own GUI one, and a child reading OUR tty would steal the user's keystrokes.
      })
      if (stdin && proc.stdin) {
        proc.stdin.write(stdin)
        await proc.stdin.end()
      }
      const timeout = setTimeout(() => { try { proc.kill() } catch { /* gone */ } }, opts?.timeoutMs ?? 30_000)
      try {
        const [out, err, code] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr), proc.exited])
        return { code, stdout: out, stderr: new TextDecoder().decode(err) }
      } finally {
        clearTimeout(timeout)
      }
    },
    async readFile(path) { return realSecretFs.readFile(path) },
    async writeFile(path, data) { await writePrivateAtomic(realSecretFs, path, data) },
    async removeFile(path) { await realSecretFs.unlink(path) },
    async createExclusive(path, data) {
      // Written complete to a tmp file, then LINKED into place: link(2) fails with EEXIST when the
      // target exists, so the file is either this process's, whole, or someone else's — never a mix.
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.new-${randomBytes(6).toString('hex')}`
      const fh = await open(tmp, 'wx', 0o600)
      try { await fh.writeFile(data); await fh.sync() } finally { await fh.close() }
      try {
        await link(tmp, path)
        await realSecretFs.fsyncDir(dirname(path))
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw err
      } finally {
        await unlink(tmp).catch(() => {})
      }
    },
    async firstExisting(candidates) { return candidates.find(c => existsSync(c)) ?? null },
    async which(cmd) { return Bun.which(cmd) },
  }
}
