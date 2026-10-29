import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

type WriteData = string | Uint8Array

type DurableOptions = { mode?: number; dirMode?: number; encoding?: BufferEncoding }

type DurableHooks = {
  fsyncFile?: (fd: number) => Promise<void>
  fsyncDir?: (fd: number) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
}

const hooks: DurableHooks = {}

/** Test-only seam. Passing null restores the real filesystem operations. */
export function __setDurableWriteHooksForTest(next: DurableHooks | null): void {
  hooks.fsyncFile = next?.fsyncFile
  hooks.fsyncDir = next?.fsyncDir
  hooks.rename = next?.rename
}

function tempPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(dirname(path), 'r')
    try {
      if (hooks.fsyncDir) await hooks.fsyncDir(handle.fd)
      else await handle.sync()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'EPERM') throw error
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'EPERM') throw error
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

export async function durableWriteFile(path: string, data: WriteData, options: DurableOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) })
  const tmp = tempPath(path)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tmp, 'w', options.mode)
    await handle.writeFile(data, options.encoding)
    if (hooks.fsyncFile) await hooks.fsyncFile(handle.fd)
    else await handle.sync()
    await handle.close()
    handle = undefined
    if (hooks.rename) await hooks.rename(tmp, path)
    else await rename(tmp, path)
    await syncDirectory(path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

export function durableWriteFileSync(path: string, data: WriteData, options: DurableOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) })
  const tmp = tempPath(path)
  try {
    const fd = openSync(tmp, 'w', options.mode)
    try {
      writeFileSync(fd, data, options.encoding)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
    if (process.platform === 'win32') return
    try {
      const dirFd = openSync(dirname(path), 'r')
      try { fsyncSync(dirFd) } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'EPERM') throw error
      } finally { closeSync(dirFd) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'EPERM') throw error
    }
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* preserve the original write error */ }
    throw error
  }
}
